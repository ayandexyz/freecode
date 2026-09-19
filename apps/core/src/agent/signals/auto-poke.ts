// =============================================================================
// Auto-poke — when the model stops with todos still open, send it back.
//
// The loop's rule is that no tool calls means the model wants to stop, and
// open todos do not override that: a planning request legitimately leaves
// every item pending. Auto-poke is the deliberate exception, OFF by default
// (`signals.autoPoke.enabled`, `FREECODE_AUTO_POKE=1`). jcode's finding is
// that most agent failures are early exits, not wrong answers; the bench
// (`bench/harness-signals/`) measures whether that holds here before the
// default moves.
//
// Four stops keep it from becoming a loop of its own:
//   cap          at most `maxPerRun` pokes per run
//   all blocked  every open item is `blocked` (waiting on the user); a poke
//                could only make the model retry or lie
//   no progress  a poke whose open ids+statuses match the last poke's is the
//                model saying it cannot finish; stop rather than repeat. The
//                fingerprint deliberately ignores item CONTENT — session
//                698c5001 re-worded a blocked item ("re-checked, still 403")
//                on every poke and was read as progress each time — and it
//                survives across runs, so a user's "continue" on an unchanged
//                list is one turn, not a fresh set of pokes (jcode keeps its
//                fingerprint at session level for the same reason)
//   nothing open every item completed or cancelled, or no list at all
//   no budget    the run's iteration cap lands before the poked turn would;
//                recording a poke nothing can answer would count against
//                the productive rate for a stop the model never saw
//
// The poke itself is one line, jcode-style: it names the count and offers
// "or update the list" as an exit. Listing every item with "pick the next
// one, do it" is what turned a blocked list into a retry loop.
//
// Decisions are pure so they can be tested without a loop.
// =============================================================================

import { isBlockedTodo, isOpenTodo, type TodoItem } from "../../tools/todo.js";

export type PokeSkipReason =
  | "disabled"
  | "nothing_open"
  | "all_blocked"
  | "cap_reached"
  | "no_progress"
  | "no_budget";

export interface PokeState {
  pokes: number;
  lastFingerprint?: string;
}

export const initialPokeState = (): PokeState => ({ pokes: 0 });

/** A new run re-arms the cap but remembers what the last poke saw. */
export const nextRunPokeState = (prev: PokeState): PokeState => ({
  pokes: 0,
  lastFingerprint: prev.lastFingerprint,
});

export type PokeDecision =
  | { poke: true; remaining: TodoItem[]; fingerprint: string }
  | { poke: false; skip: PokeSkipReason };

/** The open items, in order, with status — what "made progress" means. */
export function todoFingerprint(todos: TodoItem[]): string {
  return todos
    .filter(isOpenTodo)
    .map((t) => `${t.id}:${t.status}`)
    .join("\n");
}

export function decidePoke(input: {
  enabled: boolean;
  maxPerRun: number;
  todos: TodoItem[];
  state: PokeState;
  /** Turns the run can still take. Omit when the caller has no cap. */
  turnsLeft?: number;
}): PokeDecision {
  const remaining = input.todos.filter(isOpenTodo);
  // Order matters for what the log says: an empty list on a disabled gate
  // reads "disabled" (the gate never looked), which is the honest reason.
  if (!input.enabled) return { poke: false, skip: "disabled" };
  if (remaining.length === 0) return { poke: false, skip: "nothing_open" };
  if (remaining.every(isBlockedTodo)) return { poke: false, skip: "all_blocked" };
  if (input.state.pokes >= input.maxPerRun) return { poke: false, skip: "cap_reached" };
  if (input.turnsLeft !== undefined && input.turnsLeft < 1) {
    return { poke: false, skip: "no_budget" };
  }
  const fingerprint = todoFingerprint(input.todos);
  if (input.state.lastFingerprint === fingerprint) {
    return { poke: false, skip: "no_progress" };
  }
  return { poke: true, remaining, fingerprint };
}

export function notePoke(state: PokeState, fingerprint: string): PokeState {
  return { pokes: state.pokes + 1, lastFingerprint: fingerprint };
}

/** Longest list of named items a poke spells out (jcode: GATE_NAMED_TODO_LIMIT). */
const NAMED_LIMIT = 6;
const NAME_CHARS = 80;

/**
 * The poke, as a user-role message. Not a `<system-reminder>`: a turn whose
 * only user content is a reminder reads as empty, and models reply to it
 * ("Sure, continuing!") instead of working. jcode persists its poke as a plain
 * user turn for that reason; so does this.
 */
export function pokeMessage(remaining: TodoItem[], pokeIndex: number, max: number): string {
  const actionable = remaining.filter((t) => !isBlockedTodo(t));
  const named = actionable
    .slice(0, NAMED_LIMIT)
    .map((t) => `"${t.content.length > NAME_CHARS ? t.content.slice(0, NAME_CHARS - 1) + "…" : t.content}"`);
  const more = actionable.length - named.length;
  const n = actionable.length;
  return [
    `You stopped with ${n} todo item${n === 1 ? "" : "s"} still open (poke ${pokeIndex} of ${max}): ` +
      named.join(", ") +
      (more > 0 ? `, +${more} more` : "") +
      ".",
    "Continue working, or update the list with todowrite: mark an item blocked if it is waiting on the user, cancelled if you will not do it. Do not repeat a call that already failed.",
  ].join("\n");
}

/** One line for the frontend, so a poke is not a model that silently kept going. */
export function pokeNotice(decision: PokeDecision, remaining: number, max: number, pokes: number): string | undefined {
  if (decision.poke) {
    return `${remaining} todo${remaining === 1 ? "" : "s"} still open — sent the agent back (poke ${pokes} of ${max}).`;
  }
  switch (decision.skip) {
    case "no_progress":
      return `${remaining} todo${remaining === 1 ? "" : "s"} still open, but the last poke changed nothing — not poking again.`;
    case "cap_reached":
      return `${remaining} todo${remaining === 1 ? "" : "s"} still open after ${max} poke${max === 1 ? "" : "s"} — stopping here.`;
    case "all_blocked":
      return `${remaining} todo${remaining === 1 ? "" : "s"} blocked on you — not poking.`;
    default:
      return undefined;
  }
}
