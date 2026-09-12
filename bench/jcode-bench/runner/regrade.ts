#!/usr/bin/env tsx
// =============================================================================
// Finish the full gate on trials whose final grade timed out (or failed), with
// no cap — then rewrite report.json and re-publish.
//
//   pnpm bench:jcode:regrade bench/jcode-bench/results/<run> [--task T] [--agent A] [--all] [--timeout ms]
//
// Rebuilds each trial's workspace from the staged upstream task plus the
// artifact's `submission/` (or, for runs before it was kept, by applying
// `submission.diff`), and runs `./grade --full`. Free: no model. The result
// replaces `final` / `finalFullGate` / `finalTimedOut` on that trial.
// =============================================================================

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { finalGrade } from "./grade.js";
import { publish } from "./publish.js";
import { ensureUpstream, stageTask, taskOneLiner } from "./tasks.js";
import type { Report, TrialRecord } from "./types.js";

const ROOT = path.join(import.meta.dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const runDir = process.argv[2];
if (!runDir || runDir.startsWith("--")) {
  console.error("usage: regrade.ts <results/run-dir> [--task T] [--agent A] [--all] [--timeout ms]");
  process.exit(2);
}
const onlyTask = arg("task");
const onlyAgent = arg("agent");
const all = process.argv.includes("--all");
const timeoutMs = Number(arg("timeout") ?? 12 * 60 * 60 * 1000);

/** Restore the submission the agent left, from the artifact dir. */
function restoreSubmission(artifactDir: string, upstream: string, task: string, taskDir: string): void {
  const kept = path.join(artifactDir, "submission");
  if (fs.existsSync(kept)) {
    fs.rmSync(path.join(taskDir, "submission"), { recursive: true, force: true });
    fs.cpSync(kept, path.join(taskDir, "submission"), { recursive: true });
    return;
  }
  // Older runs kept only the diff (`diff -ruN <upstream>/tasks/<task>/submission <ws>/...`).
  // Strip the upstream prefix so the hunks land on `submission/...` in taskDir.
  const diff = fs.readFileSync(path.join(artifactDir, "submission.diff"), "utf-8");
  if (!diff.trim()) return;
  // The two sides carry different absolute prefixes (upstream vs the tmp
  // workspace), so no single -p strips both; rewrite the headers to
  // `submission/...` and apply at -p0.
  const rewritten = diff.replace(/^(---|\+\+\+) \S*?\/submission\//gm, "$1 submission/");
  const r = spawnSync("patch", ["-p0", "-d", taskDir, "--batch", "--forward"], {
    input: rewritten,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`patch failed:\n${r.stdout}${r.stderr}`);
}

function main() {
  const reportFile = path.join(runDir!, "report.json");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf-8")) as Report;
  const upstream = ensureUpstream();
  const todo = report.trials.filter(
    (t) =>
      (!onlyTask || t.task === onlyTask) &&
      (!onlyAgent || t.agent === onlyAgent) &&
      (all || t.final === null || t.finalTimedOut || !t.finalFullGate),
  );
  if (todo.length === 0) {
    console.log("nothing to regrade");
    return;
  }
  for (const t of todo) {
    const artifactDir = path.join(ROOT, t.artifactDir);
    process.stdout.write(`${t.task} t${t.trial} ${t.agent.padEnd(12)} full gate… `);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `jcode-regrade-${t.task}-`));
    try {
      const taskDir = stageTask(upstream.dir, t.task, ws);
      restoreSubmission(artifactDir, upstream.dir, t.task, taskDir);
      const fin = finalGrade(taskDir, { full: true, timeoutMs });
      fs.writeFileSync(path.join(artifactDir, "regrade.log"), fin.stdout + fin.stderr);
      if (fin.timedOut) {
        console.log(`timed out after ${Math.round(fin.durationMs / 60000)} min — unchanged`);
        continue;
      }
      applyResult(t, fin.score, fin.durationMs);
      console.log(
        fin.verified
          ? `${fin.score!.toFixed(4)} (${(2 ** fin.score!).toFixed(2)}x) in ${Math.round(fin.durationMs / 60000)} min`
          : `FAILED verification in ${Math.round(fin.durationMs / 60000)} min — no score`,
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  const oneLiners = Object.fromEntries(
    [...new Set(report.trials.map((t) => t.task))].map((k) => [k, taskOneLiner(upstream.dir, k)]),
  );
  for (const f of publish(report, oneLiners)) console.log(path.relative(process.cwd(), f));
}

function applyResult(t: TrialRecord, score: number | null, durationMs: number): void {
  t.final = score;
  t.finalFullGate = true;
  delete t.finalTimedOut;
  (t as TrialRecord & { regradeMs?: number }).regradeMs = durationMs;
}

main();
