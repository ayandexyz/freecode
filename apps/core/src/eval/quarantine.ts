// =============================================================================
// Quarantine — the other half of the gate (spec §9.3).
//
// Choosing majority-of-N IS a flaky-case policy, so this ships with the gate
// rather than after it. A quarantined case still runs and still reports; it
// just cannot turn the build red.
//
// Format: one case id per line, `#` comments, `id  # reason` inline.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { evalsDir } from "./dataset.js";
import type { CaseResult, TrialResult } from "./types.js";

/** Below this trailing pass rate a case is proposed for quarantine. */
export const QUARANTINE_BELOW = 0.9;
/** Above this it is proposed for release back into the gate. */
export const RELEASE_ABOVE = 0.98;
/** Rates computed on fewer runs than this are advisory, not actionable. */
export const MIN_RUNS_FOR_RATE = 20;
/**
 * The proposal rate is over this many most-recent trials, not all of history.
 * An all-time rate has no notion of a scoring epoch or a fix: on 2026-09-20 it
 * proposed quarantining three cases that were 7–9 of their last 10, and said
 * nothing about two quarantined cases that were 10/10 since a fix, because
 * their 72–73% all-time still counted every failure from before it. Ten is
 * three gated runs and a bit — enough to see a fix land, short enough to
 * forget one. With 10 trials, `RELEASE_ABOVE` means 10/10 and
 * `QUARANTINE_BELOW` means ≤8/10.
 */
export const RECENT_TRIALS = 10;

export function quarantinePath(): string {
  return path.join(evalsDir(), "quarantine.txt");
}

export function loadQuarantine(): Set<string> {
  const file = quarantinePath();
  if (!fs.existsSync(file)) return new Set();
  const ids = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter(Boolean);
  return new Set(ids);
}

export interface RateProposal {
  id: string;
  /** Pass rate over the last `RECENT_TRIALS` scored trials — what decides. */
  rate: number;
  /** Trials behind `rate`. */
  runs: number;
  /** All-time pass rate, reported beside `rate` so a reader sees the trend. */
  allTime: number;
  allTimeRuns: number;
}

export interface QuarantineReport {
  toQuarantine: RateProposal[];
  toRelease: RateProposal[];
  /** True while there is too little history for the rates to mean much. */
  thin: boolean;
}

/**
 * History written before 2026-09-20 carries no `infra` flag, only the reason
 * string those trials were given. This is the one reader of OLD history, so
 * it recognises them by that string; fresh results carry the flag.
 */
const LEGACY_INFRA = /^(run failed:|model error: (provider|stall)$|model call hung$)/;
function isInfra(trial: TrialResult): boolean {
  return trial.infra === true || LEGACY_INFRA.test(trial.reason);
}

/**
 * Proposals only — this never edits the file. A gate that silently quarantines
 * its own failures is a gate that always passes, which is the failure mode
 * this whole design exists to avoid.
 */
export function proposeQuarantine(
  history: CaseResult[][],
  quarantined: Set<string>,
): QuarantineReport {
  // Every scored trial per case, oldest first — `history` is append order.
  // An `infra` trial is not evidence about the agent (gate.ts leaves it out of
  // the vote for the same reason), so it is not evidence about the case.
  const trials = new Map<string, boolean[]>();
  for (const run of history) {
    for (const result of run) {
      const acc = trials.get(result.id) ?? [];
      for (const trial of result.trials) {
        if (!isInfra(trial)) acc.push(trial.passed);
      }
      trials.set(result.id, acc);
    }
  }

  const rateOf = (xs: boolean[]): number =>
    xs.filter(Boolean).length / xs.length;

  const toQuarantine: RateProposal[] = [];
  const toRelease: RateProposal[] = [];
  for (const [id, all] of trials) {
    if (all.length === 0) continue;
    const recent = all.slice(-RECENT_TRIALS);
    const rate = rateOf(recent);
    const proposal = {
      id,
      rate,
      runs: recent.length,
      allTime: rateOf(all),
      allTimeRuns: all.length,
    };
    if (quarantined.has(id)) {
      if (rate >= RELEASE_ABOVE) toRelease.push(proposal);
    } else if (rate < QUARANTINE_BELOW && recent.some(Boolean)) {
      // `recent.some(Boolean)`: quarantine is for FLAKY cases, not failing ones.
      //
      // A case that has never passed is not noise to be suppressed — it is
      // either a real finding about the agent or a broken case, and both want
      // fixing rather than silencing. Proposing it here inverted this module's
      // own stated purpose: "a gate that silently quarantines its own failures
      // is a gate that always passes". The rate rule could not tell 0% from
      // 60% and recommended both.
      //
      // Observed on a real report, which proposed quarantining 7 of 20 cases —
      // including the two consistent failures that were the suite's most
      // useful output. A report that recommends that is a report nobody reads.
      toQuarantine.push(proposal);
    }
  }

  return {
    toQuarantine: toQuarantine.sort((a, b) => a.rate - b.rate),
    toRelease: toRelease.sort((a, b) => b.rate - a.rate),
    thin: history.length < MIN_RUNS_FOR_RATE,
  };
}
