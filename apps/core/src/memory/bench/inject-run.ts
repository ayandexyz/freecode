// =============================================================================
// Injection bench entrypoint (spec 2026-09-25 §4): `pnpm bench:inject`.
//
// Runs every corpus query through `prepareMemories()` in its own session,
// renders what the model would receive, and scores that — then runs the §4.2
// lifecycle scenarios. Zero model calls: `--judge=oracle` is a labelled ceiling,
// never a real model.
//
//   pnpm bench:inject                   # metrics (judge off) + scenarios
//   pnpm bench:inject -- --judge=oracle # metrics with the perfect-reader judge
//   pnpm bench:inject -- --verbose      # + per-query rows
//   pnpm bench:inject -- --json         # raw numbers, for diffing two runs
// =============================================================================

import * as embedder from "../graph/embedder.js";
import { memoryId } from "../graph/builder.js";
import { drainMemoryJobs } from "../background-jobs.js";
import { renderRetrievedMemoriesDetailed } from "../mem-prompt.js";
import type { MemoryEntry } from "../mem-types.js";
import type { JudgeContext } from "../graph/index.js";
import { loadCorpus, openBenchStore, toEntry, validateCorpus } from "./pool.js";
import { makeOracle } from "./oracle.js";
import {
  aggregateInjection,
  formatInjection,
  type InjectionSample,
} from "./inject.js";
import { runScenarios } from "./scenarios.js";

const utf8 = (s: string) => Buffer.byteLength(s, "utf-8");

/**
 * Bytes each rendered entry contributes on its own: a full entry is its
 * `### name` heading, body, and the blank line before it; a summary is its one
 * line. Headers and the citation footer are left as overhead.
 */
function entryBytes(text: string, entries: MemoryEntry[]): {
  bytes: Record<string, number>;
  full: string[];
} {
  const bytes: Record<string, number> = {};
  const full: string[] = [];
  for (const e of entries) {
    const id = memoryId(e.type, e.name);
    if (text.includes(`### ${e.name}\n`)) {
      full.push(id);
      bytes[id] = utf8(`\n\n### ${e.name}\n${e.content}`);
    } else {
      const line = text.split("\n").find((l) => l.startsWith(`- ${e.name} `));
      bytes[id] = line ? utf8(`\n${line}`) : 0;
    }
  }
  return { bytes, full };
}

async function probeMode(): Promise<"fused" | "lexical_only"> {
  try {
    await embedder.embed("probe");
    return "fused";
  } catch {
    return "lexical_only";
  }
}

async function sampleCorpus(judged: boolean): Promise<InjectionSample[]> {
  const corpus = loadCorpus();
  const problems = validateCorpus(corpus.memories, corpus.queries);
  if (problems.length > 0) {
    throw new Error(`corpus is invalid:\n  ${problems.join("\n  ")}`);
  }
  const oracle = judged ? makeOracle(corpus) : undefined;
  const bench = openBenchStore(corpus.memories.map(toEntry));
  try {
    // Build vectors once, so the first query is not charged the whole index.
    await bench.service.retrieve("warmup", { limit: 1 });

    const samples: InjectionSample[] = [];
    for (const [i, q] of corpus.queries.entries()) {
      const session = `inject-${i}`;
      const judge: JudgeContext | undefined = oracle
        ? { provider: "bench", complete: async (_s, p) => oracle(q.query, p) }
        : undefined;

      const started = performance.now();
      await bench.service.prepareMemories(session, q.query, judge);
      const prepareMs = performance.now() - started;
      const coldMiss = bench.service.preparationFor(session).state === "pending";

      // What the next request carries once the prefetch has landed.
      await drainMemoryJobs(session, 10_000);
      const prepared = await bench.service.prepareMemories(session, q.query, judge);
      const rendered = renderRetrievedMemoriesDetailed(prepared);
      const { bytes, full } = entryBytes(rendered.text, rendered.entries);

      samples.push({
        query: q.query,
        relevant: q.relevant,
        candidates: prepared.map((e) => memoryId(e.type, e.name)),
        rendered: rendered.entries.map((e) => memoryId(e.type, e.name)),
        full,
        blockBytes: utf8(rendered.text),
        entryBytes: bytes,
        prepareMs,
        coldMiss,
      });
    }
    return samples;
  } finally {
    bench.cleanup();
  }
}

function perQuery(samples: InjectionSample[]): string {
  const rows = samples.map((s) => {
    const gold = new Set(s.relevant);
    const hit = s.rendered.filter((id) => gold.has(id)).length;
    const q = s.query.length > 48 ? `${s.query.slice(0, 45)}...` : s.query;
    const kind = s.relevant.length === 0 ? "abstain" : `${hit}/${s.relevant.length}`;
    return `| ${q} | ${kind} | ${s.rendered.length} | ${s.blockBytes} |`;
  });
  return ["| query | gold rendered | entries | bytes |", "| --- | ---: | ---: | ---: |", ...rows].join(
    "\n",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const judged = argv.includes("--judge=oracle");
  const label = judged ? "oracle judge" : "judge off";

  const mode = await probeMode();
  const started = Date.now();
  const samples = await sampleCorpus(judged);
  const metrics = aggregateInjection(samples);
  const scenarios = await runScenarios();
  const elapsedMs = Date.now() - started;

  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ mode, judge: judged ? "oracle" : "none", metrics, scenarios, elapsedMs, samples }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write(`retrieval: ${mode} · ${label} · 0 model calls\n\n`);
  process.stdout.write(`${formatInjection(metrics, label)}\n\n`);
  if (mode === "lexical_only") {
    process.stdout.write(
      "WARNING: the embedder is unavailable, so these numbers describe the\n" +
        "lexical path alone and are not comparable with a fused run.\n\n",
    );
  }
  if (argv.includes("--verbose")) process.stdout.write(`${perQuery(samples)}\n\n`);

  const passed = scenarios.filter((s) => s.pass).length;
  process.stdout.write(`Lifecycle scenarios: ${passed}/${scenarios.length} pass\n\n`);
  process.stdout.write("| scenario | result | detail |\n| --- | --- | --- |\n");
  for (const s of scenarios) {
    process.stdout.write(`| ${s.name} | ${s.pass ? "pass" : "**FAIL**"} | ${s.detail} |\n`);
  }
  process.stdout.write(`\n${elapsedMs} ms\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`bench failed: ${String(err)}\n`);
  process.exitCode = 1;
});
