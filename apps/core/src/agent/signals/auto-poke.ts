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
// Three stops keep it from becoming a loop of its own:
//   cap          at most `maxPerRun` pokes per run
//   no progress  a poke whose todo list is byte-identical to the last poke's
//                is the model saying it cannot finish; stop rather than repeat
//   nothing open every item completed or cancelled, or no list at all
//   no budget    the run's iteration cap lands before the poked turn would;
//                recording a poke nothing can answer would count against
//                the productive rate for a stop the model never saw
//
// Decisions are pure so they can be tested without a loop.
// =============================================================================

import { isOpenTodo, type TodoItem } from "../../tools/todo.js";

export type PokeSkipReason =
  | "disabled"
  | "nothing_open"
  | "cap_reached"
  | "no_progress"
  | "no_budget";

export interface PokeState {
  pokes: number;
  lastFingerprint?: string;
}

export const initialPokeState = (): PokeState => ({ pokes: 0 });

export type PokeDecision =
  | { poke: true; remaining: TodoItem[]; fingerprint: string }
  | { poke: false; skip: PokeSkipReason };

/** The open items, in order, with status — what "made progress" means. */
export function todoFingerprint(todos: TodoItem[]): string {
  return todos
    .filter(isOpenTodo)
    .map((t) => `${t.id}:${t.status}:${t.content}`)
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

/**
 * The poke, as a user-role message. Not a `<system-reminder>`: a turn whose
 * only user content is a reminder reads as empty, and models reply to it
 * ("Sure, continuing!") instead of working. jcode persists its poke as a plain
 * user turn for that reason; so does this.
 */
export function pokeMessage(remaining: TodoItem[], pokeIndex: number, max: number): string {
  const marks = { in_progress: "[~]", pending: "[ ]", completed: "[x]", cancelled: "[-]" } as const;
  return [
    `You stopped with ${remaining.length} todo item${remaining.length === 1 ? "" : "s"} still open (poke ${pokeIndex} of ${max}):`,
    ...remaining.map((t) => `${marks[t.status]} ${t.content}`),
    "Continue working: pick the next open item, do it, and mark it completed",
    "with todowrite. If an item cannot or should not be done, say why in its",
    "content and mark it cancelled — never completed — so the list stays honest.",
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
    default:
      return undefined;
  }
}
