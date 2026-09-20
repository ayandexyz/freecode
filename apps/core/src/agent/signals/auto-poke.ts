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
//                model saying it cannot finish; stop rather than repeat —
//                with ONE exception: a poke the model answered with prose
//                and no tool call at all did not bounce off "cannot finish",
//                it bounced off "did not act" (the 09-12→20 fold: 16 of 51
//                pokes ended that way, the same count as the pokes that
//                worked). That bounce gets one harder re-poke, then the
//                identical-list rule applies. A poke the model DID act on
//                and still left unchanged is a genuine stop. The
//                fingerprint deliberately ignores item CONTENT — session
//                698c5001 re-worded a blocked item ("re-checked, still 403")
//                on every poke and was read as progress each time — and it
//                survives across runs, so a user's "continue" on an unchanged
//                list is one turn, not a fresh set of pokes (jcode keeps its
//                fingerprint at session level for the same reason)
//   nothing open every item completed or cancelled, or no list at all
//   read-only    plan/review/explore: the model cannot execute a mutating
//                item, so a poke there only buys a turn of "blocked" — every
//                one of the 16 all_blocked outcomes in the 09-12→20 fold was a
//                read-only eval case that had been poked
//   no budget    the run's iteration cap lands before the poked turn would;
//                recording a poke nothing can answer would count against
//                the productive rate for a stop the model never saw
//
// The poke itself is one line, jcode-style: it names the count and leads
// with the action. `blocked` is offered last and only for an item that needs
// the user — leading with "or update the list" made marking everything
// blocked the easy exit (16 of 51 pokes in the same fold). Listing every item
// with "pick the next one, do it" is what turned a blocked list into a retry
// loop.
//
// Decisions are pure so they can be tested without a loop.
// =============================================================================

import { isBlockedTodo, isOpenTodo, type TodoItem } from "../../tools/todo.js";

export type PokeSkipReason =
  | "disabled"
  | "nothing_open"
  | "read_only_mode"
  | "all_blocked"
  | "cap_reached"
  | "no_progress"
  | "no_budget";

export interface PokeState {
  pokes: number;
  lastFingerprint?: string;
  /** The current fingerprint already had its bounce re-poke. */
  retried?: boolean;
}

export const initialPokeState = (): PokeState => ({ pokes: 0 });

/** A new run re-arms the cap but remembers what the last poke saw. */
export const nextRunPokeState = (prev: PokeState): PokeState => ({
  pokes: 0,
  lastFingerprint: prev.lastFingerprint,
  retried: prev.retried,
});

export type PokeDecision =
  | { poke: true; remaining: TodoItem[]; fingerprint: string; retry: boolean }
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
  /** The run's agent mode is read-only (plan/review/explore). */
  readOnly?: boolean;
  /**
   * Whether any tool ran since the last poke. False means the model answered
   * the poke with prose alone — the bounce that earns one harder re-poke.
   * Omit (treated as acted) when the caller does not track it.
   */
  actedSincePoke?: boolean;
}): PokeDecision {
  const remaining = input.todos.filter(isOpenTodo);
  // Order matters for what the log says: an empty list on a disabled gate
  // reads "disabled" (the gate never looked), which is the honest reason.
  if (!input.enabled) return { poke: false, skip: "disabled" };
  if (remaining.length === 0) return { poke: false, skip: "nothing_open" };
  if (input.readOnly) return { poke: false, skip: "read_only_mode" };
  if (remaining.every(isBlockedTodo)) return { poke: false, skip: "all_blocked" };
  if (input.state.pokes >= input.maxPerRun) return { poke: false, skip: "cap_reached" };
  if (input.turnsLeft !== undefined && input.turnsLeft < 1) {
    return { poke: false, skip: "no_budget" };
  }
  const fingerprint = todoFingerprint(input.todos);
  if (input.state.lastFingerprint === fingerprint) {
    const bounced = input.actedSincePoke === false && !input.state.retried;
    if (!bounced) return { poke: false, skip: "no_progress" };
    return { poke: true, remaining, fingerprint, retry: true };
  }
  return { poke: true, remaining, fingerprint, retry: false };
}

export function notePoke(state: PokeState, fingerprint: string): PokeState {
  return {
    pokes: state.pokes + 1,
    lastFingerprint: fingerprint,
    retried: state.lastFingerprint === fingerprint,
  };
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
export function pokeMessage(
  remaining: TodoItem[],
  pokeIndex: number,
  max: number,
  opts: { retry?: boolean } = {},
): string {
  const actionable = remaining.filter((t) => !isBlockedTodo(t));
  const named = actionable
    .slice(0, NAMED_LIMIT)
    .map((t) => `"${t.content.length > NAME_CHARS ? t.content.slice(0, NAME_CHARS - 1) + "…" : t.content}"`);
  const more = actionable.length - named.length;
  const n = actionable.length;
  const head =
    `You stopped with ${n} todo item${n === 1 ? "" : "s"} still open (poke ${pokeIndex} of ${max}): ` +
    named.join(", ") +
    (more > 0 ? `, +${more} more` : "") +
    ".";
  const body = opts.retry
    ? "Your last reply had no tool call. Do not reply in prose: this turn must be a tool call — pick the next open item and start it, or todowrite with an honest status for each item. Do not repeat a call that already failed."
    : "Pick the next open item and do it now. Only if an item genuinely cannot proceed, todowrite it: cancelled if you will not do it (say why), blocked only when it needs something from the user (say what). Do not repeat a call that already failed.";
  return [head, body].join("\n");
}

/** One line for the frontend, so a poke is not a model that silently kept going. */
export function pokeNotice(decision: PokeDecision, remaining: number, max: number, pokes: number): string | undefined {
  if (decision.poke) {
    const why = decision.retry ? "the agent replied without acting — sent it back again" : "sent the agent back";
    return `${remaining} todo${remaining === 1 ? "" : "s"} still open — ${why} (poke ${pokes} of ${max}).`;
  }
  switch (decision.skip) {
    case "no_progress":
      return `${remaining} todo${remaining === 1 ? "" : "s"} still open, but the last poke changed nothing — not poking again.`;
    case "cap_reached":
      return `${remaining} todo${remaining === 1 ? "" : "s"} still open after ${max} poke${max === 1 ? "" : "s"} — stopping here.`;
    case "all_blocked":
      return `${remaining} todo${remaining === 1 ? "" : "s"} blocked on you — not poking.`;
    case "read_only_mode":
      return `${remaining} todo${remaining === 1 ? "" : "s"} still open, but this mode is read-only — not poking.`;
    default:
      return undefined;
  }
}
