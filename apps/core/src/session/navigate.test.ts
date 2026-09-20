// Session tree over IPC (spec 2026-09-20-pi-parity-plan, Phase 3): navigate
// rewinds the active path, summarizes the abandoned branch under the new
// leaf, and refuses while a turn is running. Goes through handleRequest with
// a real store under a temp project (purged at the end), like server.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../server.js";
import { getAppRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import type { SerializedMessage } from "./store.js";
import { heuristicBranchSummary, branchSummaryMessage } from "./branch-summary.js";

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method, params })) as any;
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

function m(id: string, role: "user" | "assistant", text: string): SerializedMessage {
  return { id, role, parts: [{ type: "text", content: text }], timestamp: Date.now() };
}

test("session.navigate rewinds, appends a branch summary, and session.tree shows both branches", async () => {
  process.env.FREECODE_BRANCH_SUMMARY = "heuristic";
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-nav-"));
  const { sessionId } = await rpc("session.start", { projectPath, provider: "anthropic" });
  const store = await getAppRuntime().runPromise(SessionStoreTag);
  try {
    for (const e of [
      m("u1", "user", "add a login page"),
      m("a1", "assistant", "done: login.tsx"),
      m("u2", "user", "now use OAuth"),
      m("a2", "assistant", "switched to oauth"),
    ]) {
      await store.appendMessage(sessionId, e, projectPath);
    }

    const nav = await rpc("session.navigate", { sessionId, entryId: "a1", summarize: true });
    assert.equal(nav.abandoned, 2);
    assert.equal(nav.summarized, true);
    const ids = nav.messages.map((x: SerializedMessage) => x.id);
    assert.deepEqual(ids.slice(0, 2), ["u1", "a1"]);
    const summary = nav.messages[2] as SerializedMessage;
    assert.equal(summary.synthetic, "branch_summary");
    assert.equal(summary.role, "user");
    const body = summary.parts[0]!.content!;
    assert.match(body, /<branch-summary>/);
    assert.match(body, /rewound/);
    assert.match(body, /## Asked/, "heuristic digest — the test never calls a model");

    const tree = await rpc("session.tree", { sessionId });
    assert.deepEqual(
      tree.map((e: { id: string; active: boolean }) => [e.id, e.active]),
      [["u1", true], ["a1", true], ["u2", false], ["a2", false], [summary.id, true]],
    );
    assert.equal(tree.find((e: { id: string }) => e.id === summary.id).parentId, "a1");
    assert.ok(!tree.some((e: { preview: string }) => e.preview.length > 81), "previews, not bodies");

    await rpc("session.label", { sessionId, entryId: "a1", label: "before oauth" });
    const labelled = await rpc("session.tree", { sessionId });
    assert.equal(labelled.find((e: { id: string }) => e.id === "a1").label, "before oauth");

    await assert.rejects(
      () => rpc("session.navigate", { sessionId, entryId: "nope" }),
      /not found/,
    );
  } finally {
    await rpc("session.delete", { sessionId, purge: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test("the heuristic branch summary lists asks and tools without inventing progress", () => {
  const entries: SerializedMessage[] = [
    m("u", "user", "now use OAuth"),
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", content: "on it" },
        { type: "tool", tool: { name: "read", args: { path: "x" } }, result: "…" },
        { type: "tool", tool: { name: "edit", args: {} }, result: "ok" },
      ],
      timestamp: 1,
    },
  ];
  const text = heuristicBranchSummary(entries);
  assert.match(text, /- now use OAuth/);
  assert.match(text, /read×1, edit×1/);
  assert.match(branchSummaryMessage(text, 2), /2 message\(s\)/);
});
