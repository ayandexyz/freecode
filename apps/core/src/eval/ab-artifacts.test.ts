import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { captureAbProvenance, saveAbReport } from "./ab-artifacts.js";
import { summariseCase, type AbReport } from "./ab-run.js";
import type { TrialResult } from "./types.js";

test("provenance changes for tracked, staged and untracked edits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-ab-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    git("init");
    fs.writeFileSync(path.join(dir, "a.txt"), "one");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    );
    const clean = captureAbProvenance(dir)!;
    assert.equal(clean.dirty, false);
    fs.writeFileSync(path.join(dir, "a.txt"), "two");
    const dirty = captureAbProvenance(dir)!;
    assert.equal(dirty.dirty, true);
    assert.notEqual(dirty.treeHash, clean.treeHash);
    git("add", ".");
    assert.equal(captureAbProvenance(dir)!.treeHash, dirty.treeHash);
    fs.writeFileSync(path.join(dir, "untracked.txt"), "three");
    const added = captureAbProvenance(dir)!;
    assert.notEqual(added.treeHash, dirty.treeHash);
    fs.writeFileSync(path.join(dir, "untracked.txt"), "four");
    assert.notEqual(captureAbProvenance(dir)!.treeHash, added.treeHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A/B artifacts retain paired trial results and session links", () => {
  const trial = (sessionId: string, passed: boolean): TrialResult => ({
    sessionId,
    passed,
    reason: passed ? "ok" : "expected no tool",
    durationMs: 1,
    inputTokens: 10,
    outputTokens: 2,
    turns: 1,
    repeatedCalls: 0,
    redirects: 0,
    redirectsSkipped: 0,
    questionsRejected: 0,
  });
  const baseline = [trial("b1", false), trial("b2", true)];
  const candidate = [trial("c1", true), trial("c2", true)];
  const result = summariseCase(
    { id: "hi", prompt: "hi", expectTool: null },
    { baseline, candidate },
    2,
  );
  const report: AbReport = {
    suite: "trajectory",
    ranAt: "2026-09-21T00:00:00Z",
    trials: 2,
    sides: { baseline: {}, candidate: {} },
    served: { baseline: [], candidate: [] },
    cases: [result],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-ab-report-"));
  try {
    const file = saveAbReport(report, dir);
    assert.notEqual(saveAbReport(report, dir), file);
    const restored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(restored.cases[0].trialResults, { baseline, candidate });
    assert.equal(restored.cases[0].baseline.passed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
