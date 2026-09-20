import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldNudgeTodo,
  todoNudgeReminder,
  TODO_NUDGE_TURNS,
  TODO_NUDGE_GAP,
} from "./reminders.js";
test("nudge respects the turn threshold and inter-nudge gap", () => {
  // Not enough idle turns yet.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS - 1, TODO_NUDGE_GAP), false);
  // Idle long enough and gap satisfied.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS, TODO_NUDGE_GAP), true);
  // Idle long enough but nudged too recently.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS, TODO_NUDGE_GAP - 1), false);
});

test("nudge text is a system-reminder that mentions todowrite", () => {
  assert.match(todoNudgeReminder(), /<system-reminder>/);
  assert.match(todoNudgeReminder(), /todowrite/);
});

test("thresholds are Claude Code's 10/10; FREECODE_TODO_NUDGE=legacy restores 3/5 per call", () => {
  assert.equal(TODO_NUDGE_TURNS, 10);
  assert.equal(TODO_NUDGE_GAP, 10);
  const legacy = { FREECODE_TODO_NUDGE: "legacy" };
  assert.equal(shouldNudgeTodo(3, 5, {}), false);
  assert.equal(shouldNudgeTodo(3, 5, legacy), true);
  assert.equal(shouldNudgeTodo(2, 5, legacy), false);
});

test("the nudge is gentle, and with a list it asks for cleanup rather than a plan", () => {
  const fresh = todoNudgeReminder(false, {});
  assert.match(fresh, /gentle reminder/);
  assert.match(fresh, /ignore if not applicable/);
  assert.match(fresh, /Only use it if it's relevant/);
  assert.doesNotMatch(fresh, /maintain a todo list/);
  const withList = todoNudgeReminder(true, {});
  assert.match(withList, /cleaning up the todo list/);
  assert.match(todoNudgeReminder(true, { FREECODE_TODO_NUDGE: "legacy" }), /maintain a todo list/);
});
