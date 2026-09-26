#!/usr/bin/env tsx
// =============================================================================
// longmemeval.ts — external LongMemEval-S evaluation (ROADMAP "Memory:
// long-horizon evaluation" #6). Paid: every sample ingests ~48 haystack
// sessions through `extractMemories` and runs one live scored turn.
//
// NOT the official protocol. The official judge is GPT-4o via
// `evaluate_qa.py`; this grades with a configurable judge and its own
// prompt. Report results as "adapted subset", never as a LongMemEval score.
//
//   pnpm bench:longmemeval run   <corpus.json> <outDir>   # ingest + answer
//   pnpm bench:longmemeval judge <outDir> <provider> <model> <corpus.json>
//
// The corpus is NOT in the repo (277 MB). Fetch it at the pinned revision in
// `LONGMEMEVAL_SOURCE` and check its sha256 before running.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/core/src");
const core = (p: string) => import(path.join(CORE, p));

const SAMPLE_SEED = 20260926;
// 24 of 500, stratified proportionally over the six question types.
const TARGETS: Record<string, number> = {
  "multi-session": 6,
  "temporal-reasoning": 6,
  "knowledge-update": 4,
  "single-session-user": 3,
  "single-session-assistant": 3,
  "single-session-preference": 2,
};
const AGENT = { provider: "minimax", model: "MiniMax-M3" };

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function run(corpusPath: string, outDir: string) {
  const { createSandbox } = await core("eval/sandbox.js");
  const { ingestSampleHaystack, parseLongMemEvalSample, assertNoAnswerLeak } =
    await core("eval/longmemeval-adapter.js");
  const { getAppRuntime } = await core("effect/runtime.js");
  const { createAgentLoopEffect } = await core("agent/loop.js");
  const { getSessionManager } = await core("session/index.js");
  const { bus } = await core("bus/index.js");
  const { buildTrace } = await core("rollout/trace.js");
  const { loadSessionEvents } = await core("rollout/history.js");
  const { traceCost } = await core("rollout/cost.js");
  const { initProviders } = await core("providers/index.js");
  const { initMcpServers } = await core("mcp/index.js");
  await initProviders();
  await initMcpServers();

  const parsed = (JSON.parse(fs.readFileSync(corpusPath, "utf-8")) as unknown[]).map(
    (r) => parseLongMemEvalSample(r),
  );
  const byType = new Map<string, typeof parsed>();
  for (const s of parsed) byType.set(s.question_type, [...(byType.get(s.question_type) ?? []), s]);
  const rng = mulberry32(SAMPLE_SEED);
  const sampled = Object.entries(TARGETS).flatMap(([type, n]) =>
    seededShuffle(byType.get(type) ?? [], rng).slice(0, n),
  );

  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "results.jsonl");
  fs.writeFileSync(out, "");
  for (const [i, sample] of sampled.entries()) {
    const t0 = Date.now();
    console.log(`[${i + 1}/${sampled.length}] ${sample.question_id} (${sample.question_type})`);
    const record: Record<string, unknown> = {
      question_id: sample.question_id,
      question_type: sample.question_type,
      sessions: sample.haystack_sessions.length,
    };
    const sandbox = createSandbox({});
    try {
      assertNoAnswerLeak(sample.question, sample);
      record.ingest = await ingestSampleHaystack(sample, { projectPath: sandbox.dir, ...AGENT });

      const sessionId = await (await getSessionManager()).start(sandbox.dir, AGENT.provider);
      let response = "";
      const unsubscribe = bus.subscribe("stream", (e: any) => {
        if (e.sessionId === sessionId && e.event.type === "text_delta") response += e.event.delta;
      });
      const loop = await getAppRuntime().runPromise(createAgentLoopEffect(sessionId));
      await getAppRuntime().runPromise(
        loop.runEffect({
          prompt: sample.question,
          sessionId,
          ...AGENT,
          projectPath: sandbox.dir,
          agentMode: "explore",
        }),
      );
      unsubscribe();
      record.response = response;
      const events = loadSessionEvents(sessionId);
      record.scoredCostUsd = events ? (traceCost(buildTrace(sessionId, events.events))?.usd ?? null) : null;
    } catch (err) {
      record.error = (err as Error).message;
      console.log(`  error: ${record.error}`);
    } finally {
      sandbox.cleanup();
    }
    record.elapsedMs = Date.now() - t0;
    fs.appendFileSync(out, JSON.stringify(record) + "\n");
  }
  console.log(`wrote ${out}`);
}

const SYSTEM =
  "You judge whether a candidate answer to a question is correct, given a " +
  "reference ground-truth answer. Be lenient about phrasing and format " +
  "(e.g. date formats, capitalization) but strict about the actual fact. " +
  "A candidate that says it does not know or has no record is INCORRECT. " +
  'Reply with exactly one line: "CORRECT" or "INCORRECT", nothing else.';
// Only abstention (`_abs`) questions reward "I don't know". A global version of
// this rule graded two answerable "I have no record" replies CORRECT.
const SYSTEM_ABS =
  "You judge whether a candidate answer is correct. The question cannot be " +
  "answered from the conversation history (the reference explains why). A " +
  "candidate that says it does not know, or that the information was never " +
  "provided, is CORRECT; a candidate that asserts a specific answer is " +
  'INCORRECT. Reply with exactly one line: "CORRECT" or "INCORRECT".';

async function judge(outDir: string, providerId: string, model: string, corpusPath: string) {
  const { initProviders, getProvider } = await core("providers/index.js");
  const { priceUsd } = await core("providers/pricing.js");
  await initProviders();
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`no provider ${providerId}`);
  const corpus: any[] = JSON.parse(fs.readFileSync(corpusPath, "utf-8"));
  const truth = new Map(corpus.map((r) => [r.question_id, { q: r.question, a: String(r.answer) }]));

  const rows = fs
    .readFileSync(path.join(outDir, "results.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const out = path.join(outDir, "judged.jsonl");
  fs.writeFileSync(out, "");
  for (const row of rows) {
    const t = truth.get(row.question_id)!;
    let verdict: boolean | null = null;
    let raw = "";
    let judgeCostUsd: number | undefined;
    // `maxTokens` well above one word: at 16/64 the judge's reply was cut
    // mid-word ("IN", "INCOR") and parsed as no verdict.
    for (let attempt = 0; typeof row.response === "string" && attempt < 3 && verdict === null; attempt++) {
      try {
        const result = await provider.execute({
          prompt: `Question: ${t.q}\nReference answer: ${t.a}\nCandidate answer: ${row.response}`,
          system: row.question_id.endsWith("_abs") ? SYSTEM_ABS : SYSTEM,
          model,
          maxTokens: 300,
        });
        raw = (result.content ?? "").trim();
        const up = raw.toUpperCase();
        verdict = up.includes("INCORRECT") ? false : up.includes("CORRECT") ? true : null;
        judgeCostUsd = priceUsd(providerId, model, {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
      } catch (e) {
        raw = `error: ${(e as Error).message}`;
      }
    }
    fs.appendFileSync(
      out,
      JSON.stringify({ ...row, groundTruth: t.a, verdict, judgeRaw: raw, judgeCostUsd, judge: `${providerId}/${model}` }) + "\n",
    );
    console.log(row.question_id, row.question_type, "->", verdict);
  }
  console.log(`wrote ${out}`);
}

const [cmd, ...args] = process.argv.slice(2);
const done = (p: Promise<unknown>) =>
  p.then(
    // The agent loop leaves handles open (see TODO.md, "freecode eval does not
    // exit"); results are on disk by now.
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
if (cmd === "run" && args.length === 2) done(run(args[0], args[1]));
else if (cmd === "judge" && args.length === 4) done(judge(args[0], args[1], args[2], args[3]));
else {
  console.error(
    "usage: longmemeval.ts run <corpus.json> <outDir>\n" +
      "       longmemeval.ts judge <outDir> <provider> <model> <corpus.json>",
  );
  process.exit(2);
}
