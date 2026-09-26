// =============================================================================
// Injection metrics (spec 2026-09-25 §4.1): what the model actually receives.
//
// `metrics.ts` scores what retrieve() ranks. The model never sees that list: it
// sees the prepared set for its session, cut by the renderer's byte budget. A
// relevant memory that retrieval found but the budget dropped is a miss here,
// and bytes spent on irrelevant memories are pure cost.
//
// Pure: no store, no service, no I/O — tested against hand-computed values.
// =============================================================================

export interface InjectionSample {
  query: string;
  /** Gold ids; [] marks an abstention query. */
  relevant: string[];
  /** Ids the preparation handed to the renderer, best first. */
  candidates: string[];
  /** Ids represented in the rendered block. */
  rendered: string[];
  /** Of `rendered`, the ids sent with their full body. */
  full: string[];
  /** UTF-8 bytes of the whole block (0 when nothing was injected). */
  blockBytes: number;
  /** UTF-8 bytes attributable to each rendered entry's own lines. */
  entryBytes: Record<string, number>;
  /** How long the first `prepareMemories` call took, in ms. */
  prepareMs: number;
  /** True when the first call returned before retrieval landed. */
  coldMiss: boolean;
}

export interface InjectionMetrics {
  queries: number;
  abstentionQueries: number;
  candidateRecall: number;
  renderedRecall: number;
  fullBodyRecall: number;
  /** Gold ÷ rendered, over scored queries that rendered anything. */
  renderedPrecision: number;
  abstentionAccuracy: number;
  /** Mean block bytes per request, over every query. */
  meanBlockBytes: number;
  /** Bytes on gold entries / non-gold entries / headers+footer, summed. */
  goldBytes: number;
  nonGoldBytes: number;
  overheadBytes: number;
  /** Gold ids that were candidates but did not survive rendering. */
  budgetDrops: number;
  prepareP50Ms: number;
  prepareMaxMs: number;
  coldMisses: number;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

function coverage(ids: string[], gold: string[]): number {
  if (gold.length === 0) return 0;
  const have = new Set(ids);
  return gold.filter((g) => have.has(g)).length / gold.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function aggregateInjection(
  samples: InjectionSample[],
): InjectionMetrics {
  const scored = samples.filter((s) => s.relevant.length > 0);
  const abstain = samples.filter((s) => s.relevant.length === 0);

  let goldBytes = 0;
  let nonGoldBytes = 0;
  let overheadBytes = 0;
  let budgetDrops = 0;
  for (const s of samples) {
    const gold = new Set(s.relevant);
    let entries = 0;
    for (const id of s.rendered) {
      const b = s.entryBytes[id] ?? 0;
      entries += b;
      if (gold.has(id)) goldBytes += b;
      else nonGoldBytes += b;
    }
    overheadBytes += Math.max(0, s.blockBytes - entries);
    const rendered = new Set(s.rendered);
    budgetDrops += s.candidates.filter(
      (id) => gold.has(id) && !rendered.has(id),
    ).length;
  }

  const withOutput = scored.filter((s) => s.rendered.length > 0);
  const prepare = samples.map((s) => s.prepareMs);

  return {
    queries: scored.length,
    abstentionQueries: abstain.length,
    candidateRecall: mean(scored.map((s) => coverage(s.candidates, s.relevant))),
    renderedRecall: mean(scored.map((s) => coverage(s.rendered, s.relevant))),
    fullBodyRecall: mean(scored.map((s) => coverage(s.full, s.relevant))),
    renderedPrecision: mean(
      withOutput.map(
        (s) =>
          s.rendered.filter((id) => s.relevant.includes(id)).length /
          s.rendered.length,
      ),
    ),
    abstentionAccuracy: mean(abstain.map((s) => (s.rendered.length === 0 ? 1 : 0))),
    meanBlockBytes: mean(samples.map((s) => s.blockBytes)),
    goldBytes,
    nonGoldBytes,
    overheadBytes,
    budgetDrops,
    prepareP50Ms: median(prepare),
    prepareMaxMs: prepare.length ? Math.max(...prepare) : 0,
    coldMisses: samples.filter((s) => s.coldMiss).length,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

export function formatInjection(m: InjectionMetrics, label: string): string {
  const spent = m.goldBytes + m.nonGoldBytes + m.overheadBytes;
  return [
    `| metric | ${label} |`,
    `| --- | ---: |`,
    `| candidate recall | ${pct(m.candidateRecall)} |`,
    `| **rendered recall** | ${pct(m.renderedRecall)} |`,
    `| full-body recall | ${pct(m.fullBodyRecall)} |`,
    `| rendered precision | ${pct(m.renderedPrecision)} |`,
    `| abstention accuracy | ${pct(m.abstentionAccuracy)} |`,
    `| mean block / request | ${Math.round(m.meanBlockBytes)} B (~${Math.round(m.meanBlockBytes / 4)} tok) |`,
    `| bytes on gold | ${kb(m.goldBytes)} (${pct(spent ? m.goldBytes / spent : 0)}) |`,
    `| **bytes on non-gold** | ${kb(m.nonGoldBytes)} (${pct(spent ? m.nonGoldBytes / spent : 0)}) |`,
    `| headers + footer | ${kb(m.overheadBytes)} (${pct(spent ? m.overheadBytes / spent : 0)}) |`,
    `| gold dropped by budget | ${m.budgetDrops} |`,
    `| prepare p50 / max | ${m.prepareP50Ms.toFixed(0)} / ${m.prepareMaxMs.toFixed(0)} ms |`,
    `| cold misses | ${m.coldMisses} |`,
    ``,
    `${m.queries} scored queries, ${m.abstentionQueries} abstention queries.`,
  ].join("\n");
}
