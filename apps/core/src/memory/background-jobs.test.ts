import test from "node:test";
import assert from "node:assert/strict";
import { drainMemoryJobs, trackMemoryJob } from "./background-jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("drain with nothing tracked returns immediately", async () => {
  assert.deepEqual(await drainMemoryJobs("none", 1_000), {
    pending: 0,
    timedOut: false,
  });
});

test("drain waits for a job that finishes within the budget", async () => {
  let done = false;
  void trackMemoryJob("s-ok", sleep(20).then(() => (done = true)));
  const result = await drainMemoryJobs("s-ok", 1_000);
  assert.equal(done, true);
  assert.deepEqual(result, { pending: 0, timedOut: false });
});

test("a job outliving the budget is reported as pending, not as done", async () => {
  // The failure this guards: an eval trial reading a timed-out drain as "no
  // memory spend" and presenting the missing cost as a saving.
  void trackMemoryJob("s-slow", sleep(500));
  const result = await drainMemoryJobs("s-slow", 20);
  assert.equal(result.timedOut, true);
  assert.equal(result.pending, 1);
});

test("a rejected job settles the drain without throwing", async () => {
  void trackMemoryJob("s-fail", Promise.reject(new Error("boom"))).catch(
    () => {},
  );
  assert.deepEqual(await drainMemoryJobs("s-fail", 1_000), {
    pending: 0,
    timedOut: false,
  });
});

test("jobs are scoped to their session", async () => {
  void trackMemoryJob("s-a", sleep(500));
  assert.deepEqual(await drainMemoryJobs("s-b", 20), {
    pending: 0,
    timedOut: false,
  });
});
