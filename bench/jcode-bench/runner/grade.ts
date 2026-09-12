// =============================================================================
// The official final grade — the upstream `./grade`, run by the harness after
// the agent exits, on the submission exactly as it was left.
//
// This is separate from the agent's own grades on purpose: `best` on the page
// is the highest sample the AGENT saw, and jcode's page notes it can sit above
// the official final because not every sample runs the full gate. `final` is
// the number that counts; a failed verify makes it null.
// =============================================================================

import { spawnSync } from "child_process";
import { parseFinalScore } from "./curve.js";

export interface FinalGrade {
  score: number | null;
  fullGate: boolean;
  verified: boolean;
  /** The grader hit `timeoutMs` — not a verdict either way. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function finalGrade(
  taskDir: string,
  opts: { full: boolean; timeoutMs: number },
): FinalGrade {
  const started = Date.now();
  // coreutils `timeout` rather than spawnSync's own: the grader forks the
  // verifier, and spawnSync's timeout kills only python, leaving a 2^32
  // verify running for an hour after the run moved on. `timeout` signals
  // the whole group. Exit 124 is its "timed out".
  const r = spawnSync(
    "timeout",
    [
      "-k",
      "10",
      String(Math.ceil(opts.timeoutMs / 1000)),
      "python3",
      "grade",
      ...(opts.full ? ["--full"] : []),
      "--quiet",
    ],
    { cwd: taskDir, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = r.stdout ?? "";
  const timedOut = r.status === 124;
  const score = r.status === 0 ? parseFinalScore(stdout) : null;
  return {
    score,
    fullGate: opts.full,
    verified: r.status === 0 && score !== null,
    timedOut,
    stdout,
    stderr: r.stderr ?? "",
    durationMs: Date.now() - started,
  };
}

/**
 * The full gate first; if it runs past `timeoutMs`, the sampled gate instead.
 *
 * float-print's full gate checks all 2^32 floats and took over an hour on a
 * laptop against a Ryu-style submission. A run that reported that as
 * "FAILED verification" published a wrong submission where there was only a
 * slow verifier. The sampled grade is the same `./grade` the agent used;
 * `finalFullGate: false` + `finalTimedOut: true` say exactly what happened,
 * and `regrade.ts` can finish the full gate later with no cap.
 */
export function finalGradeWithFallback(
  taskDir: string,
  opts: { full: boolean; timeoutMs: number },
): FinalGrade {
  const first = finalGrade(taskDir, opts);
  if (!opts.full || !first.timedOut) return first;
  const sampled = finalGrade(taskDir, { full: false, timeoutMs: opts.timeoutMs });
  return { ...sampled, timedOut: true };
}

/** The grader needs cc, python3 and valgrind. Say which is missing before spending. */
export function checkToolchain(): void {
  const missing = ["cc", "python3", "valgrind"].filter(
    (bin) => spawnSync(bin, ["--version"], { encoding: "utf-8" }).status !== 0,
  );
  if (missing.length) {
    throw new Error(
      `jcode-bench needs ${missing.join(", ")} on PATH (callgrind is the cost model). ` +
        `Arch: sudo pacman -S valgrind gcc python; Debian: sudo apt install valgrind build-essential python3`,
    );
  }
}
