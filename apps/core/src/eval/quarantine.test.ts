import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadQuarantine, proposeQuarantine, RECENT_TRIALS } from "./quarantine.js";
import type { CaseResult, TrialResult } from "./types.js";

const trial = (passed: boolean): TrialResult => ({
  passed,
  reason: "",
  durationMs: 1,
  inputTokens: 0,
  outputTokens: 0,
});

const result = (id: string, passes: boolean[]): CaseResult => ({
  id,
  trials: passes.map(trial),
  passed: true,
  consistent: passes.every(Boolean),
  quarantined: false,
});

function withEvalsDir<T>(contents: string | null, fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-quarantine-"));
  if (contents !== null) {
    fs.writeFileSync(path.join(dir, "quarantine.txt"), contents, "utf-8");
  }
  const prev = process.env.FREECODE_EVALS_DIR;
  process.env.FREECODE_EVALS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FREECODE_EVALS_DIR;
    else process.env.FREECODE_EVALS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parses ids, ignoring comments and inline reasons", () => {
  const ids = withEvalsDir(
    "# header\n\nflaky-one  # 60%, revisit after prompt change\nflaky-two\n",
    loadQuarantine,
  );
  assert.deepEqual([...ids].sort(), ["flaky-one", "flaky-two"]);
});

test("a missing quarantine file is an empty set, not an error", () => {
  // The harness must run in a checkout that never created one.
  assert.equal(withEvalsDir(null, loadQuarantine).size, 0);
});

test("proposes quarantine below 90% and release above 98%", () => {
  const history = [
    [result("solid", [true, true]), result("flaky", [true, false])],
    [result("solid", [true, true]), result("flaky", [false, false])],
  ];
  const report = proposeQuarantine(history, new Set());
  assert.deepEqual(
    report.toQuarantine.map((p) => p.id),
    ["flaky"],
  );
  assert.equal(report.toRelease.length, 0);
});

test("proposes releasing a quarantined case that has become reliable", () => {
  const history = [[result("fixed", [true, true, true, true])]];
  const report = proposeQuarantine(history, new Set(["fixed"]));
  assert.deepEqual(
    report.toRelease.map((p) => p.id),
    ["fixed"],
  );
  // Already quarantined — it must not also be proposed for quarantine.
  assert.equal(report.toQuarantine.length, 0);
});

test("the proposal rate is over the last RECENT_TRIALS, not all of history", () => {
  // A quarantined case that was broken for a long time and then fixed: 20
  // failures then 10 passes is 33% all-time, 100% recent. All-time never
  // released it; the recent window does — and reports both numbers.
  const past = Array.from({ length: 10 }, () => [result("fixed", [false, false])]);
  const now = Array.from({ length: 5 }, () => [result("fixed", [true, true])]);
  const report = proposeQuarantine([...past, ...now], new Set(["fixed"]));
  assert.deepEqual(report.toRelease.map((p) => p.id), ["fixed"]);
  assert.equal(report.toRelease[0].rate, 1);
  assert.equal(report.toRelease[0].runs, RECENT_TRIALS);
  assert.equal(report.toRelease[0].allTime, 1 / 3);
  assert.equal(report.toRelease[0].allTimeRuns, 30);

  // The reverse: a case that recently started flaking is proposed even though
  // its all-time rate is still fine.
  const solid = Array.from({ length: 10 }, () => [result("slipping", [true, true])]);
  const shaky = Array.from({ length: 5 }, () => [result("slipping", [true, false])]);
  const r2 = proposeQuarantine([...solid, ...shaky], new Set());
  assert.deepEqual(r2.toQuarantine.map((p) => p.id), ["slipping"]);
  assert.equal(r2.toQuarantine[0].rate, 0.5);
});

test("infra trials are not evidence about a case", () => {
  const infra: TrialResult = { ...trial(false), infra: true };
  const run: CaseResult = { ...result("a", [true, true]), trials: [trial(true), infra, infra] };
  const report = proposeQuarantine([[run], [run]], new Set());
  // 2 passes, 4 outages: 100% of what ran, not 33%.
  assert.equal(report.toQuarantine.length, 0);
});

test("flags thin history so early rates read as advisory", () => {
  const report = proposeQuarantine([[result("a", [true])]], new Set());
  assert.equal(report.thin, true);
});

test("every quarantined id names a case that actually exists", async () => {
  // Was "starts empty", which stopped being the invariant when the 2026-08-29
  // bootstrap populated the file (eval-harness spec §14.1). Empty was never the
  // property worth protecting anyway — a STALE id is, because a quarantine
  // entry for a case that has been renamed or deleted silently protects
  // nothing, and nothing else in the system would ever mention it again.
  const dir = path.resolve(import.meta.dirname, "../../../../evals");
  const prev = process.env.FREECODE_EVALS_DIR;
  process.env.FREECODE_EVALS_DIR = dir;
  try {
    const { parseSuite } = await import("./dataset.js");
    const known = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const cases = parseSuite(
        fs.readFileSync(path.join(dir, file), "utf-8"),
        file,
      );
      if (cases.length === 0) continue;
      for (const kase of cases) {
        known.add(kase.id);
      }
    }
    for (const id of loadQuarantine()) {
      assert.ok(known.has(id), `quarantined id '${id}' matches no case`);
    }
  } finally {
    if (prev === undefined) delete process.env.FREECODE_EVALS_DIR;
    else process.env.FREECODE_EVALS_DIR = prev;
  }
});

test("a case that never passes is not proposed for quarantine", () => {
  // Quarantine suppresses noise. A 0% case is a finding or a broken case, and
  // silencing either one is how a gate stops meaning anything.
  const report = proposeQuarantine(
    [[result("always-fails", [false, false, false])]],
    new Set(),
  );
  assert.equal(
    report.toQuarantine.find((p) => p.id === "always-fails"),
    undefined,
  );
});

test("a genuinely flaky case is still proposed", () => {
  const report = proposeQuarantine(
    [[result("flaky", [true, false, false])]],
    new Set(),
  );
  assert.equal(report.toQuarantine[0]?.id, "flaky");
});
