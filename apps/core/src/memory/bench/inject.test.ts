import test from "node:test";
import assert from "node:assert/strict";
import { aggregateInjection, type InjectionSample } from "./inject.js";

function sample(over: Partial<InjectionSample>): InjectionSample {
  return {
    query: "q",
    relevant: [],
    candidates: [],
    rendered: [],
    full: [],
    blockBytes: 0,
    entryBytes: {},
    prepareMs: 10,
    coldMiss: false,
    ...over,
  };
}

test("rendered recall counts only what reached the block", () => {
  // Gold `a` and `b` were both candidates; the budget dropped `b`.
  const m = aggregateInjection([
    sample({
      relevant: ["a", "b"],
      candidates: ["a", "x", "b"],
      rendered: ["a", "x"],
      full: ["a"],
      blockBytes: 1000,
      entryBytes: { a: 400, x: 300 },
    }),
  ]);
  assert.equal(m.candidateRecall, 1);
  assert.equal(m.renderedRecall, 0.5);
  assert.equal(m.fullBodyRecall, 0.5);
  assert.equal(m.renderedPrecision, 0.5);
  assert.equal(m.budgetDrops, 1);
  assert.equal(m.goldBytes, 400);
  assert.equal(m.nonGoldBytes, 300);
  assert.equal(m.overheadBytes, 300);
});

test("a summary-only gold counts for rendered but not full-body recall", () => {
  const m = aggregateInjection([
    sample({ relevant: ["a"], candidates: ["a"], rendered: ["a"], full: [] }),
  ]);
  assert.equal(m.renderedRecall, 1);
  assert.equal(m.fullBodyRecall, 0);
});

test("abstention: every byte of an off-topic block is non-gold or overhead", () => {
  const m = aggregateInjection([
    sample({ rendered: [], blockBytes: 0 }),
    sample({ rendered: ["x"], blockBytes: 500, entryBytes: { x: 200 } }),
  ]);
  assert.equal(m.abstentionQueries, 2);
  assert.equal(m.queries, 0);
  assert.equal(m.abstentionAccuracy, 0.5);
  assert.equal(m.goldBytes, 0);
  assert.equal(m.nonGoldBytes, 200);
  assert.equal(m.overheadBytes, 300);
  assert.equal(m.meanBlockBytes, 250);
});

test("precision skips scored queries that rendered nothing", () => {
  // Averaging a 0/0 in as 0 would punish abstaining on a query retrieval
  // missed; that miss is already counted by recall.
  const m = aggregateInjection([
    sample({ relevant: ["a"], rendered: ["a"] }),
    sample({ relevant: ["b"], rendered: [] }),
  ]);
  assert.equal(m.renderedPrecision, 1);
  assert.equal(m.renderedRecall, 0.5);
});

test("latency is median and max, cold misses are counted", () => {
  const m = aggregateInjection([
    sample({ prepareMs: 10 }),
    sample({ prepareMs: 30, coldMiss: true }),
    sample({ prepareMs: 20 }),
  ]);
  assert.equal(m.prepareP50Ms, 20);
  assert.equal(m.prepareMaxMs, 30);
  assert.equal(m.coldMisses, 1);
});

test("empty input folds to zeros", () => {
  const m = aggregateInjection([]);
  assert.equal(m.renderedRecall, 0);
  assert.equal(m.prepareMaxMs, 0);
});
