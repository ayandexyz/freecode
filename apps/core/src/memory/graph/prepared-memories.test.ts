// What a session's requests actually carry, over a real store and the real
// retrieval path (spec 2026-09-25 §4.3; bench scenarios in memory/bench/).
//
// Edits and deletes: a session's prepared memories must follow the store.
// Before the fix, `onChange` updated vectors and the graph but never a
// session's stash, and a resolved query was never re-fetched, so the pre-edit
// entry — or a deleted one — rode every request for the rest of the topic.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "stash-inval-home-"));

import { MemoryStore } from "../mem-store.js";
import { MemoryGraphService, type JudgeContext } from "./index.js";
import { drainMemoryJobs } from "../background-jobs.js";
import { serializeMemoryEntry, type MemoryEntry } from "../mem-types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUERY = "which package manager should I use to install dependencies";

const PNPM: MemoryEntry = {
  type: "project",
  name: "uses-pnpm",
  description: "This repo uses pnpm as its package manager to install dependencies",
  content: "Install dependencies with pnpm install.",
  createdAt: 0,
  updatedAt: 0,
};
const OTHER: MemoryEntry = {
  type: "user",
  name: "timezone-ist",
  description: "User works in the IST timezone",
  content: "Deadlines assume Asia/Kolkata.",
  createdAt: 0,
  updatedAt: 0,
};

function open(entries: MemoryEntry[]) {
  const dir = mkdtempSync(join(tmpdir(), "stash-inval-"));
  const store = new MemoryStore(dir);
  for (const e of entries) store.save(e);
  const service = new MemoryGraphService(store);
  return {
    store,
    service,
    cleanup: () => {
      service.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function countingJudge(delayMs = 0): { ctx: JudgeContext; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    ctx: {
      provider: "test",
      complete: async (_s, prompt) => {
        calls++;
        if (delayMs) await sleep(delayMs);
        const n = prompt.split("\n").filter((l) => /^\d+\.\s/.test(l.trim())).length;
        return JSON.stringify(Array.from({ length: n }, (_, i) => i + 1));
      },
    },
  };
}

async function settled(
  service: MemoryGraphService,
  session: string,
  judge?: JudgeContext,
): Promise<MemoryEntry[]> {
  await service.prepareMemories(session, QUERY, judge);
  await drainMemoryJobs(session, 5_000);
  return service.prepareMemories(session, QUERY, judge);
}

const find = (entries: MemoryEntry[], name: string) =>
  entries.find((e) => e.name === name);

test("an edited memory is injected with its new text", async () => {
  const { store, service, cleanup } = open([PNPM]);
  try {
    assert.equal(find(await settled(service, "s"), "uses-pnpm")?.content, PNPM.content);
    store.save({ ...PNPM, content: "Install dependencies with bun install." });
    const after = await settled(service, "s");
    assert.equal(find(after, "uses-pnpm")?.content, "Install dependencies with bun install.");
  } finally {
    cleanup();
  }
});

test("a deleted memory is never injected again", async () => {
  const { store, service, cleanup } = open([PNPM]);
  try {
    assert.ok(find(await settled(service, "s"), "uses-pnpm"));
    store.delete(PNPM.name, PNPM.type);
    // Even the very next read, before any refetch lands, must not carry it.
    assert.equal(find(service.peekMemories("s"), "uses-pnpm"), undefined);
    assert.equal(find(await settled(service, "s"), "uses-pnpm"), undefined);
  } finally {
    cleanup();
  }
});

test("an edit during an in-flight prefetch is not overwritten by stale results", async () => {
  const { store, service, cleanup } = open([PNPM]);
  try {
    let judging!: () => void;
    const judgeStarted = new Promise<void>((r) => (judging = r));
    const ctx: JudgeContext = {
      provider: "test",
      complete: async () => {
        judging();
        await sleep(200);
        return "[1]";
      },
    };
    await service.prepareMemories("s", QUERY, ctx);
    // Retrieval has read the old entry; the judge is deciding about it now.
    await judgeStarted;
    store.save({ ...PNPM, content: "Install dependencies with bun install." });
    await drainMemoryJobs("s", 5_000);
    const after = await service.prepareMemories("s", QUERY, ctx);
    assert.equal(find(after, "uses-pnpm")?.content, "Install dependencies with bun install.");
  } finally {
    cleanup();
  }
});

test("editing an injected memory re-judges it; an unrelated edit does not", async () => {
  const { store, service, cleanup } = open([PNPM, OTHER]);
  try {
    const { ctx, calls } = countingJudge();
    // Judge keeps everything; OTHER may or may not be a candidate — what
    // matters is that only a change to something the session holds re-judges.
    const first = await settled(service, "s", ctx);
    assert.equal(calls(), 1);
    const held = new Set(first.map((e) => e.name));

    const unrelated = held.has("timezone-ist") ? null : OTHER;
    if (unrelated) {
      store.save({ ...unrelated, content: "Deadlines assume UTC." });
      await settled(service, "s", ctx);
      assert.equal(calls(), 1, "a memory the session does not hold changes nothing");
    }

    // The verdict was about the old description; a changed memory needs a new one.
    store.save({ ...PNPM, description: "This repo uses bun to install dependencies" });
    const after = await settled(service, "s", ctx);
    assert.equal(calls(), 2);
    assert.equal(find(after, "uses-pnpm")?.description, "This repo uses bun to install dependencies");
  } finally {
    cleanup();
  }
});

test("a change in one session's memory leaves another session's stash alone", async () => {
  const { store, service, cleanup } = open([PNPM, OTHER]);
  try {
    await settled(service, "a");
    const before = service.preparationFor("b");
    store.delete(PNPM.name, PNPM.type);
    assert.deepEqual(service.preparationFor("b"), before);
  } finally {
    cleanup();
  }
});

test("a superseded memory is replaced by its successor, never injected beside it", async () => {
  const OLD: MemoryEntry = {
    ...PNPM,
    name: "uses-npm",
    description: "This repo uses npm as its package manager to install dependencies",
    content: "Install dependencies with npm install.",
  };
  const { service, cleanup } = open([OLD, { ...PNPM, supersedes: ["uses-npm"] }]);
  try {
    const got = (await settled(service, "s")).map((e) => e.name);
    assert.ok(got.includes("uses-pnpm"), `got [${got.join(", ")}]`);
    assert.ok(!got.includes("uses-npm"), `got [${got.join(", ")}]`);
    // Still searchable: supersession filters injection, not the store.
    const searched = (await service.retrieve(QUERY)).map((e) => e.name);
    assert.ok(searched.includes("uses-npm"));
  } finally {
    cleanup();
  }
});

// Secrets: nothing model-bound — the judge prompt or the injected block — may
// carry a memory that looks like it holds a credential, however it got there.
const SECRET = "sk-ant-api03-TESTFAKEKEY0123456789abcdef";

test("a secret-bearing file written outside the writers never reaches the model", async () => {
  const { store, service, cleanup } = open([PNPM]);
  try {
    const leaked: MemoryEntry = {
      ...PNPM,
      type: "reference",
      name: "registry-token",
      description: "Package manager registry token to install private dependencies",
      content: `token for installing dependencies: ${SECRET}`,
    };
    const file = join(store.getMemoryDir(), "reference", "registry-token.md");
    mkdirSync(join(store.getMemoryDir(), "reference"), { recursive: true });
    writeFileSync(file, serializeMemoryEntry(leaked), "utf-8");

    const prompts: string[] = [];
    const judge: JudgeContext = {
      provider: "test",
      complete: async (_s, prompt) => {
        prompts.push(prompt);
        return "[1, 2]";
      },
    };
    const got = await settled(service, "s", judge);
    assert.ok(got.some((e) => e.name === "uses-pnpm"), "the clean memory still flows");
    assert.ok(!got.some((e) => e.name === "registry-token"));
    assert.ok(!prompts.join("").includes("registry token"), "not shown to the judge");
  } finally {
    cleanup();
  }
});

test("an edit that adds a secret drops the memory from the stash at once", async () => {
  const { store, service, cleanup } = open([PNPM]);
  try {
    assert.ok(find(await settled(service, "s"), "uses-pnpm"));
    store.save({ ...PNPM, content: `${PNPM.content} password: ${SECRET}` });
    assert.equal(find(service.peekMemories("s"), "uses-pnpm"), undefined);
    assert.equal(find(await settled(service, "s"), "uses-pnpm"), undefined);
  } finally {
    cleanup();
  }
});

// First request with a judge (spec 2026-09-25 §6.1): the judge is a network
// call and never fits the 60 ms cold budget, so the first request carried no
// memory in 24/24 eval trials. On a cold miss the unjudged candidates ride the
// first request; the verdict governs from the next one.
test("a slow judge no longer leaves the first request empty", async () => {
  const { service, cleanup } = open([PNPM]);
  try {
    const judge: JudgeContext = {
      provider: "test",
      complete: async () => {
        await sleep(300);
        return "[1]";
      },
    };
    const first = await service.prepareMemories("s", QUERY, judge);
    assert.ok(find(first, "uses-pnpm"), "unjudged candidate served on the cold path");
    assert.equal(service.preparationFor("s").state, "unjudged");

    await drainMemoryJobs("s", 5_000);
    const next = await service.prepareMemories("s", QUERY, judge);
    assert.ok(find(next, "uses-pnpm"));
    assert.equal(service.preparationFor("s").state, "fresh");
  } finally {
    cleanup();
  }
});

test("the verdict still removes what it rejects, from the next request on", async () => {
  const { service, cleanup } = open([PNPM]);
  try {
    const judge: JudgeContext = {
      provider: "test",
      complete: async () => {
        await sleep(200);
        return "[]";
      },
    };
    await service.prepareMemories("s", QUERY, judge);
    await drainMemoryJobs("s", 5_000);
    assert.equal(find(await service.prepareMemories("s", QUERY, judge), "uses-pnpm"), undefined);
  } finally {
    cleanup();
  }
});

test("a warm session never swaps its judged set for unjudged candidates", async () => {
  const { service, cleanup } = open([PNPM, OTHER]);
  try {
    let verdict = "[1]";
    const judge: JudgeContext = { provider: "test", complete: async () => verdict };
    await settled(service, "s", judge);
    verdict = "[]";
    // Same topic, new wording: the carried verdict applies; nothing unjudged
    // may appear while a refresh is in flight.
    const follow = await service.prepareMemories(
      "s",
      "which package manager should I use to install dependencies in the workspace",
      judge,
    );
    assert.notEqual(service.preparationFor("s").state, "unjudged");
    assert.ok(follow.length <= 1);
  } finally {
    cleanup();
  }
});
