// =============================================================================
// End-to-end proof that a stop with open todos becomes a poke the next turn can
// see, that a poke that changes nothing ends the run instead of repeating, and
// that with the gate off the loop records the decision and stops as before.
//
// Same rig as redirect/loop-redirect.test.ts: real loop, fake provider,
// recorder in a temp dir, settings through a temp project.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../../effect/layers.js";
import { makeRuntime } from "../../effect/runtime.js";
import { SessionStoreTag } from "../../effect/context.js";
import { createAgentLoopEffect } from "../loop.js";
import { MemoryService } from "../../compaction/service.js";
import { createRecorder } from "../../rollout/recorder.js";
import { registerProvider } from "../../providers/registry.js";
import type { ProviderId } from "../../providers/config.js";
import type {
  AIProvider,
  ExecuteOptions,
  ExecuteResult,
  ProviderChunk,
} from "../../providers/types.js";
import { clearTodos } from "../../tools/todo.js";
import { bus } from "../../bus/index.js";

const info = {
  id: "poke-fake",
  name: "poke-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** Every ephemeral tail the loop sent, where reminders ride. */
const tailsSeen: string[] = [];
/** The last user message of every request — where the poke rides. */
const lastUserSeen: string[] = [];

registerProvider("poke-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async (): Promise<ExecuteResult> => ({
      content: "",
      stopReason: "stop",
      provider: "poke-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    // Turn 1: write a plan with one item done and one open, rated low on
    // confidence. Every later turn: plain text — the model declares victory.
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      tailsSeen.push(opts.ephemeralTail ?? "");
      const users = (opts.messages ?? []).filter((m) => m.role === "user");
      const last = users[users.length - 1];
      lastUserSeen.push(
        last?.parts.map((p) => (p.type === "text" ? p.content : "")).join("") ?? "",
      );
      if (tailsSeen.length === 1) {
        yield {
          type: "tool_call",
          id: "call-1",
          name: "todowrite",
          args: {
            todos: [
              { id: "a", content: "read the spec", status: "completed", confidence: 90 },
              { id: "b", content: "make it faster", status: "pending", confidence: 30, hillClimbability: 40 },
            ],
          },
        };
      } else {
        yield { type: "text", text: "All done." };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function runLoop(sessionId: string, signals: Record<string, unknown>, runs = 1) {
  clearTodos(sessionId);
  tailsSeen.length = 0;
  lastUserSeen.length = 0;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-poke-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-poke-project-"));
  mkdirSync(join(projectPath, ".freecode"), { recursive: true });
  writeFileSync(
    join(projectPath, ".freecode", "settings.json"),
    JSON.stringify({ signals }),
    "utf-8",
  );

  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) => createRecorder(id, { rolloutDir }),
      },
    }),
  );
  const store = await runtime.runPromise(SessionStoreTag);
  await store.createSession({ title: "t", projectPath, provider: "poke-fake" }, sessionId);
  const loop = await runtime.runPromise(
    createAgentLoopEffect(sessionId, { maxIterations: 10 }),
  );
  const notices: string[] = [];
  const unsub = bus.subscribe("stream", (e) => {
    const ev = (e as { event: { type: string; content?: string } }).event;
    if (ev.type === "notice" && ev.content) notices.push(ev.content);
  });
  let result;
  for (let i = 0; i < runs; i++) {
    result = await loop.run({
      prompt: "Make it faster",
      sessionId,
      provider: "poke-fake",
      projectPath,
    });
  }
  unsub();
  await runtime.dispose();
  const events = readEvents(rolloutDir);
  const stored = await store.getMessages(sessionId, projectPath);
  rmSync(rolloutDir, { recursive: true, force: true });
  rmSync(projectPath, { recursive: true, force: true });
  clearTodos(sessionId);
  return { result, events, turns: tailsSeen.length, notices, stored };
}

test("a stop with open todos is poked once, and a poke that moves nothing ends the run", async () => {
  const { events, turns } = await runLoop("poke-on", {
    autoPoke: { enabled: true, maxPerRun: 3 },
    hillClimbGate: { enabled: true },
  });

  const triggered = events.filter((e) => e.type === "poke.triggered");
  assert.equal(triggered.length, 1, "poked exactly once");
  assert.equal(triggered[0]!.pokeIndex, 1);
  assert.equal(triggered[0]!.remaining, 1);

  // The list was byte-identical after the poke, so the second stop is
  // recorded as no progress and the run ends there — not at the cap.
  const skipped = events.filter((e) => e.type === "poke.skipped");
  assert.deepEqual(
    skipped.map((e) => e.reason),
    ["no_progress"],
  );
  // turn 1 plan, turn 2 stop → poke, turn 3 stop → no progress. Three turns.
  assert.equal(turns, 3);

  // The poke is the next turn's last USER message — a real turn with content,
  // not a reminder-only tail — naming the open item.
  const poked = lastUserSeen.filter((t) => t.includes("still open"));
  assert.equal(poked.length, 1);
  assert.match(poked[0]!, /\[ \] make it faster/);
  assert.match(poked[0]!, /poke 1 of 3/);
  assert.ok(!poked[0]!.includes("<system-reminder>"));
  assert.ok(!tailsSeen.some((t) => t.includes("still open")));

  // The low hill-climb rating was recorded and, with its gate on, nudged.
  const signals = events.filter((e) => e.type === "todo.signal");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "hill_climb_low");
  assert.equal(signals[0]!.itemId, "b");
  assert.equal(signals[0]!.to, 40);
  assert.equal(signals[0]!.gated, true);
  assert.ok(
    !JSON.stringify(signals[0]).includes("make it faster"),
    "item text never reaches the rollout log",
  );
  assert.ok(tailsSeen.some((t) => t.includes("hill-climbability 40")));
});

test("the poke and the stop are both surfaced to the frontend as notices", async () => {
  const { notices } = await runLoop("poke-notice", { autoPoke: { enabled: true, maxPerRun: 3 } });
  assert.deepEqual(notices, [
    "1 todo still open — sent the agent back (poke 1 of 3).",
    "1 todo still open, but the last poke changed nothing — not poking again.",
  ]);
});

test("the poke is persisted as a synthetic user message, so the transcript alternates on resume", async () => {
  const { stored } = await runLoop("poke-stored", { autoPoke: { enabled: true, maxPerRun: 3 } });
  const roles = stored.map((m) => `${m.role}${m.synthetic ? `:${m.synthetic}` : ""}`);
  // prompt, plan (tool call), "All done.", poke, "All done." again.
  assert.deepEqual(roles, ["user", "assistant", "assistant", "user:auto_poke", "assistant"]);
  const poke = stored.find((m) => m.synthetic === "auto_poke")!;
  assert.match(poke.parts[0]!.content!, /still open/);
});

test("poke state is per run: the next prompt on the same loop is poked afresh", async () => {
  // Run 1: plan, stop → poke, stop → no progress. Run 2 starts with the same
  // open list; a stale fingerprint would read it as no progress and never
  // poke, and a stale count would spend the cap across prompts.
  const { events } = await runLoop("poke-two-runs", { autoPoke: { enabled: true, maxPerRun: 3 } }, 2);
  const triggered = events.filter((e) => e.type === "poke.triggered");
  assert.equal(triggered.length, 2, "one poke per run");
  assert.deepEqual(
    triggered.map((e) => e.pokeIndex),
    [1, 1],
    "the count restarted with the run",
  );
});

test("with the gate off, the stop is recorded as disabled and nothing is poked", async () => {
  const { events, turns } = await runLoop("poke-off", {});
  assert.equal(events.filter((e) => e.type === "poke.triggered").length, 0);
  const skipped = events.filter((e) => e.type === "poke.skipped");
  assert.deepEqual(skipped.map((e) => e.reason), ["disabled"]);
  assert.equal(turns, 2, "plan, then stop — exactly as before the gate existed");
  assert.ok(!lastUserSeen.some((t) => t.includes("still open")));
  // The signal is still recorded — gated: false — so the bench can compare.
  const signals = events.filter((e) => e.type === "todo.signal");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.gated, false);
  assert.ok(!tailsSeen.some((t) => t.includes("hill-climbability")));
});
