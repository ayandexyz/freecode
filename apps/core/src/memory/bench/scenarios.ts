// =============================================================================
// Injection lifecycle scenarios (spec 2026-09-25 §4.2).
//
// Deterministic scripts over the PRODUCTION graph service, each asking one
// question about what a session's request would carry. A failing scenario is a
// finding, not an error: `runScenarios` never throws on a failure, so a known
// bug is visible in every bench run without blocking unrelated work. Each fix
// for a finding also gets a focused regression test next to the code it fixes.
//
// No model calls: the judge, when a scenario needs one, is a scripted
// `complete` seam that counts its calls.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { drainMemoryJobs } from "../background-jobs.js";
import { renderRetrievedMemoriesDetailed, MAX_MEMORY_BLOCK_BYTES } from "../mem-prompt.js";
import { serializeMemoryEntry, type MemoryEntry, type MemoryType } from "../mem-types.js";
import type { JudgeContext } from "../graph/index.js";
import { openBenchStore, type BenchStore } from "./pool.js";

export interface ScenarioResult {
  name: string;
  pass: boolean;
  detail: string;
}

type Scenario = { name: string; run: () => Promise<Omit<ScenarioResult, "name">> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mem(
  type: MemoryType,
  name: string,
  description: string,
  content: string,
  extra: Partial<MemoryEntry> = {},
): MemoryEntry {
  return { type, name, description, content, createdAt: 0, updatedAt: 0, ...extra };
}

const PNPM = mem(
  "project",
  "uses-pnpm",
  "This repo uses pnpm as its package manager, never npm or yarn",
  "Install dependencies with pnpm install. The lockfile is pnpm-lock.yaml; npm install breaks the workspace links.",
);
const TIMEZONE = mem(
  "user",
  "timezone-ist",
  "User works in IST timezone; deadlines and schedules assume Asia/Kolkata",
  "All dates and times discussed default to Asia/Kolkata unless stated otherwise.",
);
const PKG_QUERY = "which package manager should I use to install dependencies here";

/** A judge seam that approves every candidate and counts its calls. */
function countingJudge(
  opts: { delayMs?: number; reply?: (n: number) => string; fail?: boolean } = {},
): { ctx: JudgeContext; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    ctx: {
      provider: "bench",
      complete: async (_system, prompt) => {
        calls++;
        if (opts.delayMs) await sleep(opts.delayMs);
        if (opts.fail) throw new Error("judge provider unavailable");
        const n = prompt.split("\n").filter((l) => /^\d+\.\s/.test(l.trim())).length;
        return opts.reply ? opts.reply(n) : JSON.stringify(Array.from({ length: n }, (_, i) => i + 1));
      },
    },
  };
}

/**
 * A judge that keeps a candidate only when its description shares a word of
 * five or more letters with the request. Crude, deterministic, and enough to
 * separate "stale state leaked" from "retrieval had nothing to abstain with".
 */
function keywordJudge(): JudgeContext {
  return {
    provider: "bench",
    complete: async (_system, prompt) => {
      const [request, listed = ""] = prompt.split("Stored memories:");
      const words = new Set(request.toLowerCase().match(/[a-z]{5,}/g) ?? []);
      const keep: number[] = [];
      for (const line of listed.split("\n")) {
        const m = line.trim().match(/^(\d+)\.\s+\[\w+\]\s+(.*)$/);
        if (!m) continue;
        const hit = (m[2].toLowerCase().match(/[a-z]{5,}/g) ?? []).some((w) => words.has(w));
        if (hit) keep.push(Number(m[1]));
      }
      return JSON.stringify(keep);
    },
  };
}

/**
 * What one request would carry: prepare, drain the background prefetch so the
 * next call sees its result, then prepare again and render — exactly the pair
 * of calls a turn and its follow-up request make.
 */
async function settled(
  b: BenchStore,
  session: string,
  query: string,
  judge?: JudgeContext,
): Promise<{ text: string; names: string[] }> {
  await b.service.prepareMemories(session, query, judge);
  await drainMemoryJobs(session, 5_000);
  const prepared = await b.service.prepareMemories(session, query, judge);
  const rendered = renderRetrievedMemoriesDetailed(prepared);
  return { text: rendered.text, names: rendered.entries.map((e) => e.name) };
}

async function withStore<T>(
  entries: MemoryEntry[],
  fn: (b: BenchStore) => Promise<T>,
): Promise<T> {
  const b = openBenchStore(entries);
  try {
    // Warm the embedder/vector sidecar so scenarios measure the session path,
    // not a first-ever model load.
    await b.service.retrieve("warmup", { limit: 1 });
    return await fn(b);
  } finally {
    b.cleanup();
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: "first message, fast retrieval",
    run: () =>
      withStore([PNPM, TIMEZONE], async (b) => {
        const first = await b.service.prepareMemories("s", PKG_QUERY);
        const names = first.map((e) => e.name);
        return {
          pass: names.includes("uses-pnpm"),
          detail: `first request carried [${names.join(", ")}]`,
        };
      }),
  },
  {
    // The judge never fits the 60 ms cold budget, so the first request carries
    // retrieval's unjudged candidates and the verdict governs the next one
    // (spec 2026-09-25 §6.1: before this, 0/24 first requests had memory).
    name: "judge slower than the cold budget",
    run: () =>
      withStore([PNPM], async (b) => {
        const { ctx } = countingJudge({ delayMs: 200 });
        const first = await b.service.prepareMemories("s", PKG_QUERY, ctx);
        const state = b.service.preparationFor("s").state;
        await drainMemoryJobs("s", 5_000);
        const next = await b.service.prepareMemories("s", PKG_QUERY, ctx);
        const nextState = b.service.preparationFor("s").state;
        const pass =
          first.some((e) => e.name === "uses-pnpm") &&
          state === "unjudged" &&
          next.some((e) => e.name === "uses-pnpm") &&
          nextState === "fresh";
        return {
          pass,
          detail: `first: ${first.length} (${state}); next request: ${next.length} (${nextState})`,
        };
      }),
  },
  {
    name: "same-topic follow-up",
    run: () =>
      withStore([PNPM], async (b) => {
        const { ctx, calls } = countingJudge();
        await settled(b, "s", PKG_QUERY, ctx);
        const follow = await settled(
          b,
          "s",
          "which package manager should I use to install dependencies in the workspace",
          ctx,
        );
        return {
          pass: follow.names.includes("uses-pnpm") && calls() === 1,
          detail: `follow-up carried [${follow.names.join(", ")}], judge calls ${calls()}`,
        };
      }),
  },
  {
    name: "abrupt topic switch",
    run: () =>
      withStore([PNPM, TIMEZONE], async (b) => {
        // A topical judge, so an irrelevant candidate is filtered and anything
        // left from the old topic can only be stale session state.
        const judge = keywordJudge();
        await settled(b, "s", PKG_QUERY, judge);
        const immediate = await b.service.prepareMemories(
          "s",
          "what timezone are my deadlines in",
          judge,
        );
        const leaked = immediate.some((e) => e.name === "uses-pnpm");
        return {
          pass: !leaked,
          detail: leaked
            ? "the previous topic's memory rode the new topic's first request"
            : `new topic's first request carried [${immediate.map((e) => e.name).join(", ")}]`,
        };
      }),
  },
  {
    name: "repeated identical prompt",
    run: () =>
      withStore([PNPM], async (b) => {
        const { ctx, calls } = countingJudge();
        for (let i = 0; i < 3; i++) await settled(b, "s", PKG_QUERY, ctx);
        return { pass: calls() === 1, detail: `3 identical requests, ${calls()} judge call(s)` };
      }),
  },
  {
    name: "memory edited mid-session",
    run: () =>
      withStore([PNPM], async (b) => {
        await settled(b, "s", PKG_QUERY);
        b.store.save({
          ...PNPM,
          content: "Install dependencies with bun install. The team switched from pnpm to bun.",
        });
        await sleep(100);
        const after = await settled(b, "s", PKG_QUERY);
        const fresh = after.text.includes("switched from pnpm to bun");
        return {
          pass: fresh,
          detail: fresh
            ? "next request carried the edited text"
            : "next request still carried the pre-edit text",
        };
      }),
  },
  {
    name: "memory deleted mid-session",
    run: () =>
      withStore([PNPM], async (b) => {
        await settled(b, "s", PKG_QUERY);
        b.store.delete(PNPM.name, PNPM.type);
        await sleep(100);
        const after = await settled(b, "s", PKG_QUERY);
        const stale = after.names.includes("uses-pnpm");
        return {
          pass: !stale,
          detail: stale ? "the deleted memory was still injected" : "the deleted memory is gone",
        };
      }),
  },
  {
    name: "memory superseded",
    run: () =>
      withStore(
        [
          mem(
            "project",
            "uses-npm",
            "This repo uses npm as its package manager to install dependencies",
            "Install dependencies with npm install.",
          ),
          { ...PNPM, supersedes: ["uses-npm"] },
        ],
        async (b) => {
          const got = await settled(b, "s", PKG_QUERY);
          const pass = got.names.includes("uses-pnpm") && !got.names.includes("uses-npm");
          return { pass, detail: `injected [${got.names.join(", ")}]` };
        },
      ),
  },
  {
    // The renderer's contract, not ranking quality: the budget is spent in
    // retrieval order and degrades whole entries. Which of several similar
    // memories ranks first is retrieval's job (bench:recall) and deliberately
    // not second-guessed at injection time — docs/DECISIONS.md.
    name: "memories competing for budget",
    run: () =>
      withStore(
        [
          { ...PNPM, content: `${PNPM.content} ${"Use the workspace protocol. ".repeat(20)}` },
          ...Array.from({ length: 5 }, (_, i) =>
            mem(
              "project",
              `install-note-${i}`,
              `Note ${i} about installing dependencies with a package manager`,
              "Dependencies are installed before the build. ".repeat(30),
            ),
          ),
        ],
        async (b) => {
          await b.service.prepareMemories("s", PKG_QUERY);
          await drainMemoryJobs("s", 5_000);
          const ranked = await b.service.prepareMemories("s", PKG_QUERY);
          const rendered = renderRetrievedMemoriesDetailed(ranked);
          const bytes = Buffer.byteLength(rendered.text, "utf-8");
          const top = ranked[0];
          const topFull = !!top && rendered.text.includes(`### ${top.name}\n${top.content}`);
          const whole = rendered.entries.every(
            (e) => !rendered.text.includes(`### ${e.name}\n`) || rendered.text.includes(e.content),
          );
          return {
            pass: bytes <= MAX_MEMORY_BLOCK_BYTES && topFull && whole,
            detail:
              `${bytes} B / ${MAX_MEMORY_BLOCK_BYTES} B cap; ${rendered.fullCount} full, ` +
              `${rendered.summaryCount} summarised, ${ranked.length - rendered.entries.length} dropped; ` +
              `top-ranked ${topFull ? "kept its body" : "lost its body"}`,
          };
        },
      ),
  },
  {
    name: "judge outage",
    run: () =>
      withStore([PNPM], async (b) => {
        const { ctx } = countingJudge({ fail: true });
        const got = await settled(b, "s", PKG_QUERY, ctx);
        const decision = b.service.preparationFor("s").judgeDecision;
        return {
          pass: got.names.length === 0 && decision === "failed",
          detail: `injected ${got.names.length}, decision ${decision}`,
        };
      }),
  },
  {
    name: "malformed verdict",
    run: () =>
      withStore([PNPM], async (b) => {
        const { ctx } = countingJudge({ reply: () => "sure, the first one looks useful" });
        const got = await settled(b, "s", PKG_QUERY, ctx);
        const decision = b.service.preparationFor("s").judgeDecision;
        return {
          pass: got.names.length === 0 && decision === "unparseable",
          detail: `injected ${got.names.length}, decision ${decision}`,
        };
      }),
  },
  {
    name: "secret-bearing file written outside the writers",
    run: () =>
      withStore([PNPM], async (b) => {
        // Written straight to disk, as a hand edit or another tool would, so no
        // save-time check ever sees it.
        const secret = "sk-ant-api03-BENCHFAKEKEY0123456789abcdef";
        const leaked = mem(
          "reference",
          "deploy-credentials",
          "Package manager registry token used to install private dependencies",
          `Registry auth for installing dependencies: ${secret}`,
        );
        const file = path.join(b.store.getMemoryDir(), "reference", "deploy-credentials.md");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeMemoryEntry(leaked), "utf-8");
        const got = await settled(b, "s", "how do I install private dependencies with the package manager registry token");
        const exposed = got.text.includes(secret);
        return {
          pass: !exposed,
          detail: exposed ? "the secret reached the model-bound block" : "secret kept out of the block",
        };
      }),
  },
];

export async function runScenarios(): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    try {
      out.push({ name: s.name, ...(await s.run()) });
    } catch (error) {
      out.push({ name: s.name, pass: false, detail: `scenario errored: ${String(error)}` });
    }
  }
  return out;
}
