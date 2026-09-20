import test from "node:test";
import assert from "node:assert/strict";
import type { TodoItem } from "../../tools/todo.js";
import { resolveSignalSettings, DEFAULT_SIGNAL_SETTINGS } from "./settings.js";
import { diffTodoSignals } from "./todo-signals.js";
import {
  decidePoke,
  initialPokeState,
  nextRunPokeState,
  notePoke,
  pokeMessage,
  todoFingerprint,
} from "./auto-poke.js";

const item = (o: Partial<TodoItem> & { id: string }): TodoItem => ({
  content: `task ${o.id}`,
  status: "pending",
  ...o,
});

// --- settings ---------------------------------------------------------------

test("every gate is off by default", () => {
  const s = resolveSignalSettings([], {});
  assert.equal(s.autoPoke.enabled, false);
  assert.equal(s.confidenceGate.enabled, false);
  assert.equal(s.hillClimbGate.enabled, false);
  assert.deepEqual(s, DEFAULT_SIGNAL_SETTINGS);
});

test("project scope beats user scope beats default", () => {
  const s = resolveSignalSettings(
    [{ autoPoke: { maxPerRun: 1 } }, { autoPoke: { enabled: true, maxPerRun: 9 } }],
    {},
  );
  assert.equal(s.autoPoke.enabled, true, "user scope fills what project left unset");
  assert.equal(s.autoPoke.maxPerRun, 1, "project scope wins where it speaks");
});

test("env flag beats both files, in either direction", () => {
  const on = resolveSignalSettings([{ autoPoke: { enabled: false } }], {
    FREECODE_AUTO_POKE: "1",
  });
  assert.equal(on.autoPoke.enabled, true);
  const off = resolveSignalSettings([{ confidenceGate: { enabled: true } }], {
    FREECODE_CONFIDENCE_GATE: "0",
  });
  assert.equal(off.confidenceGate.enabled, false);
  // Garbage in the env is "unset", not "on".
  const junk = resolveSignalSettings([], { FREECODE_HILLCLIMB_GATE: "maybe" });
  assert.equal(junk.hillClimbGate.enabled, false);
});

// --- todo signals -----------------------------------------------------------

test("a completion that jumps confidence by the spike or more is a signal", () => {
  const prev = [item({ id: "a", status: "in_progress", confidence: 40 })];
  const next = [item({ id: "a", status: "completed", confidence: 95 })];
  const sig = diffTodoSignals(prev, next, { spike: 40, threshold: 90 });
  assert.deepEqual(sig, [
    { kind: "confidence_spike", itemId: "a", content: "task a", from: 40, to: 95 },
  ]);
});

test("stepping up gradually is not a spike", () => {
  const prev = [item({ id: "a", status: "in_progress", confidence: 70 })];
  const next = [item({ id: "a", status: "completed", confidence: 95 })];
  assert.deepEqual(diffTodoSignals(prev, next, { spike: 40, threshold: 90 }), []);
});

test("a spike needs a completion — revising confidence mid-flight is fine", () => {
  const prev = [item({ id: "a", status: "in_progress", confidence: 20 })];
  const next = [item({ id: "a", status: "in_progress", confidence: 90 })];
  assert.deepEqual(diffTodoSignals(prev, next, { spike: 40, threshold: 90 }), []);
});

test("an item with no prior number cannot spike", () => {
  const prev = [item({ id: "a", status: "in_progress" })];
  const next = [item({ id: "a", status: "completed", confidence: 100 })];
  assert.deepEqual(diffTodoSignals(prev, next, { spike: 40, threshold: 90 }), []);
});

test("a low hill-climb rating fires once per rating, not per call", () => {
  const first = diffTodoSignals([], [item({ id: "a", hillClimbability: 55 })], {
    spike: 40,
    threshold: 90,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, "hill_climb_low");
  // Same rating re-sent: silence.
  const again = diffTodoSignals(
    [item({ id: "a", hillClimbability: 55 })],
    [item({ id: "a", hillClimbability: 55, status: "in_progress" })],
    { spike: 40, threshold: 90 },
  );
  assert.deepEqual(again, []);
  // Re-rated, still low: fires again.
  const rerated = diffTodoSignals(
    [item({ id: "a", hillClimbability: 55 })],
    [item({ id: "a", hillClimbability: 60 })],
    { spike: 40, threshold: 90 },
  );
  assert.equal(rerated.length, 1);
});

test("a completed item is never asked to reframe", () => {
  const sig = diffTodoSignals(
    [],
    [item({ id: "a", status: "completed", hillClimbability: 10 })],
    { spike: 40, threshold: 90 },
  );
  assert.deepEqual(sig, []);
});

// --- auto-poke --------------------------------------------------------------

const open = [item({ id: "1", status: "completed" }), item({ id: "2", status: "pending" })];

test("disabled is the reason even when nothing is open", () => {
  const d = decidePoke({ enabled: false, maxPerRun: 3, todos: [], state: initialPokeState() });
  assert.deepEqual(d, { poke: false, skip: "disabled" });
});

test("an all-completed list, or no list, never pokes", () => {
  const done = [item({ id: "1", status: "completed" })];
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: done, state: initialPokeState() }),
    { poke: false, skip: "nothing_open" },
  );
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: [], state: initialPokeState() }),
    { poke: false, skip: "nothing_open" },
  );
});

test("pokes while items are open, up to the cap", () => {
  let state = initialPokeState();
  const first = decidePoke({ enabled: true, maxPerRun: 2, todos: open, state });
  assert.equal(first.poke, true);
  if (!first.poke) return;
  assert.equal(first.remaining.length, 1);
  state = notePoke(state, first.fingerprint);

  // The model made progress (list changed) — poke again.
  const moved = [item({ id: "2", status: "in_progress" }), item({ id: "3" })];
  const second = decidePoke({ enabled: true, maxPerRun: 2, todos: moved, state });
  assert.equal(second.poke, true);
  if (!second.poke) return;
  state = notePoke(state, second.fingerprint);

  const third = decidePoke({ enabled: true, maxPerRun: 2, todos: [item({ id: "9" })], state });
  assert.deepEqual(third, { poke: false, skip: "cap_reached" });
});

test("an unchanged list after a poke the model acted on is no progress, and stops the run", () => {
  const state = notePoke(initialPokeState(), todoFingerprint(open));
  const d = decidePoke({ enabled: true, maxPerRun: 3, todos: open, state, actedSincePoke: true });
  assert.deepEqual(d, { poke: false, skip: "no_progress" });
  // A caller that does not track acting is treated as acted — never two pokes.
  assert.deepEqual(decidePoke({ enabled: true, maxPerRun: 3, todos: open, state }), {
    poke: false,
    skip: "no_progress",
  });
});

test("a read-only mode is never poked: the model cannot execute a mutating item there", () => {
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: initialPokeState(), readOnly: true }),
    { poke: false, skip: "read_only_mode" },
  );
  // Reads after nothing_open (an empty list in plan mode is just "nothing
  // open") and before all_blocked (a blocked list in plan mode is the mode).
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: [], state: initialPokeState(), readOnly: true }),
    { poke: false, skip: "nothing_open" },
  );
});

test("a poke answered with prose and no tool call is re-poked once, harder, then stops", () => {
  const fp = todoFingerprint(open);
  const state = notePoke(initialPokeState(), fp);
  const again = decidePoke({ enabled: true, maxPerRun: 3, todos: open, state, actedSincePoke: false });
  assert.equal(again.poke, true);
  if (!again.poke) return;
  assert.equal(again.retry, true);
  const msg = pokeMessage(again.remaining, 2, 3, { retry: true });
  assert.match(msg, /no tool call/);
  assert.match(msg, /must be a tool call/);
  // The retry is spent on that fingerprint: a third identical stop is no
  // progress even if the model bounced again, and so is the same list after
  // a new run (nextRunPokeState keeps the flag with the fingerprint).
  const spent = notePoke(state, fp);
  assert.equal(spent.retried, true);
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: spent, actedSincePoke: false }),
    { poke: false, skip: "no_progress" },
  );
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: nextRunPokeState(spent), actedSincePoke: false }),
    { poke: false, skip: "no_progress" },
  );
  // A list that moved gets a normal poke and a fresh retry.
  const moved = [item({ id: "1", status: "completed" }), item({ id: "2", status: "in_progress" })];
  const fresh = decidePoke({ enabled: true, maxPerRun: 3, todos: moved, state: spent, actedSincePoke: false });
  assert.equal(fresh.poke && fresh.retry, false);
  assert.equal(notePoke(spent, todoFingerprint(moved)).retried, false);
  // The cap still wins over a retry.
  const capped = { ...state, pokes: 3 };
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: capped, actedSincePoke: false }),
    { poke: false, skip: "cap_reached" },
  );
});

test("the fingerprint ignores completed items, so finishing one is progress", () => {
  const a = [item({ id: "1" }), item({ id: "2" })];
  const b = [item({ id: "1", status: "completed" }), item({ id: "2" })];
  assert.notEqual(todoFingerprint(a), todoFingerprint(b));
  const c = [item({ id: "2" })];
  assert.equal(todoFingerprint(b), todoFingerprint(c));
});

test("re-wording an open item is not progress", () => {
  // Session 698c5001: "push — BLOCKED on 403" became "push — BLOCKED on 403.
  // Re-checked, still 403" on every poke, and each re-wording bought another
  // poke and another identical push.
  const a = [item({ id: "1", content: "push - blocked on 403" })];
  const b = [item({ id: "1", content: "push - blocked on 403, re-checked" })];
  assert.equal(todoFingerprint(a), todoFingerprint(b));
});

test("a list whose open items are all blocked is not poked", () => {
  const parked = [
    item({ id: "1", status: "completed" }),
    item({ id: "2", status: "blocked", content: "push tag - need push rights" }),
    item({ id: "3", status: "blocked", content: "verify release - after push" }),
  ];
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: parked, state: initialPokeState() }),
    { poke: false, skip: "all_blocked" },
  );
  // One actionable item among blocked ones is still poked for, and the poke
  // names only that one.
  const mixed = [...parked, item({ id: "4", content: "write the changelog" })];
  const d = decidePoke({ enabled: true, maxPerRun: 3, todos: mixed, state: initialPokeState() });
  assert.equal(d.poke, true);
  if (!d.poke) return;
  const msg = pokeMessage(d.remaining, 1, 3);
  assert.match(msg, /1 todo item still open/);
  assert.match(msg, /"write the changelog"/);
  assert.ok(!msg.includes("push tag"));
  assert.ok(!msg.includes("[ ]"), "one line of names, not a checklist");
});

test("the poke names at most six items, truncated, on one line", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    item({ id: String(i), content: `item ${i} ${"x".repeat(100)}` }),
  );
  const msg = pokeMessage(many, 2, 3);
  const [head, tail] = msg.split("\n");
  assert.match(head!, /9 todo items still open \(poke 2 of 3\)/);
  assert.equal((head!.match(/"item \d/g) ?? []).length, 6);
  assert.match(head!, /\+3 more/);
  assert.ok(!head!.includes("x".repeat(90)), "long content is cut");
  // Action first; `blocked` is the last word, not the offered exit.
  assert.match(tail!, /^Pick the next open item and do it now\./);
  assert.ok(tail!.indexOf("cancelled") < tail!.indexOf("blocked"));
});

test("a new run re-arms the cap but keeps the fingerprint", () => {
  const spent = { pokes: 3, lastFingerprint: todoFingerprint(open) };
  const next = nextRunPokeState(spent);
  assert.equal(next.pokes, 0);
  // Same list after the user's "continue": that was the poke. No more.
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: next }),
    { poke: false, skip: "no_progress" },
  );
  // The list moved: poke as normal.
  const moved = [item({ id: "1", status: "completed" }), item({ id: "2", status: "in_progress" })];
  assert.equal(decidePoke({ enabled: true, maxPerRun: 3, todos: moved, state: next }).poke, true);
});

test("a cancelled item is closed: it is not poked for and not asked to reframe", () => {
  const dropped = [
    item({ id: "1", status: "completed" }),
    item({ id: "2", status: "cancelled", content: "not needed after all" }),
  ];
  assert.deepEqual(
    decidePoke({ enabled: true, maxPerRun: 3, todos: dropped, state: initialPokeState() }),
    { poke: false, skip: "nothing_open" },
  );
  // Cancelling an open item is progress, the same as completing it.
  const before = [item({ id: "1" }), item({ id: "2" })];
  const after = [item({ id: "1" }), item({ id: "2", status: "cancelled" })];
  assert.notEqual(todoFingerprint(before), todoFingerprint(after));
  const s = diffTodoSignals([], [item({ id: "2", status: "cancelled", hillClimbability: 10 })], {
    spike: 40,
    threshold: 90,
  });
  assert.deepEqual(s, []);
});

test("no turn budget left is its own skip reason, before the fingerprint is consulted", () => {
  const d = decidePoke({
    enabled: true,
    maxPerRun: 3,
    todos: open,
    state: initialPokeState(),
    turnsLeft: 0,
  });
  assert.deepEqual(d, { poke: false, skip: "no_budget" });
  const ok = decidePoke({ enabled: true, maxPerRun: 3, todos: open, state: initialPokeState(), turnsLeft: 1 });
  assert.equal(ok.poke, true);
});
