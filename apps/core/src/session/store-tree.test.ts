// Session tree (spec 2026-09-20-pi-parity-plan, Phase 3): navigate to an
// earlier entry, continue from there, and keep the abandoned branch in the log.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, type SerializedMessage } from "./store.js";
import { formatSessionDirName } from "../store/path-formatter.js";

const project = "/tmp/tree-project";

function msg(id: string, role: "user" | "assistant", text: string): SerializedMessage {
  return { id, role, parts: [{ type: "text", content: text }], timestamp: Date.now() };
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "freecode-tree-"));
  const store = await createSessionStore(dir);
  const id = await store.createSession({ title: "t", projectPath: project, provider: "p" });
  const log = () =>
    readFileSync(join(dir, "sessions", formatSessionDirName(project), id, "messages.jsonl"), "utf-8");
  return { dir, store, id, log, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a session that never navigates is a plain linear log — no parentId on any line", async () => {
  const { store, id, log, done } = await rig();
  for (const m of [msg("u1", "user", "a"), msg("a1", "assistant", "b"), msg("u2", "user", "c")]) {
    await store.appendMessage(id, m, project);
  }
  assert.ok(!log().includes("parentId"));
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u1", "a1", "u2"]);
  const tree = await store.getTree(id, project);
  assert.deepEqual(tree.map((e) => [e.id, e.parentId, e.active]), [
    ["u1", undefined, true],
    ["a1", "u1", true],
    ["u2", "a1", true],
  ]);
  done();
});

test("navigate back, append, and the new entry continues from the chosen leaf", async () => {
  const { store, id, log, done } = await rig();
  for (const m of [
    msg("u1", "user", "first ask"),
    msg("a1", "assistant", "first answer"),
    msg("u2", "user", "wrong turn"),
    msg("a2", "assistant", "wrong answer"),
  ]) {
    await store.appendMessage(id, m, project);
  }
  const nav = await store.navigate(id, "a1", project);
  assert.deepEqual(nav.path.map((m) => m.id), ["u1", "a1"]);
  assert.deepEqual(nav.abandoned.map((m) => m.id), ["u2", "a2"]);
  assert.equal((await store.getMeta(id, project))?.leafId, "a1");
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u1", "a1"]);

  await store.appendMessage(id, msg("u3", "user", "better ask"), project);
  await store.appendMessage(id, msg("a3", "assistant", "better answer"), project);
  // Only the first entry after the navigate names its parent; after that the
  // previous-line rule applies again and the pointer is gone.
  const lines = log().trim().split("\n").map((l) => JSON.parse(l) as SerializedMessage);
  assert.equal(lines.find((l) => l.id === "u3")?.parentId, "a1");
  assert.equal(lines.find((l) => l.id === "a3")?.parentId, undefined);
  assert.equal((await store.getMeta(id, project))?.leafId, undefined);

  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u1", "a1", "u3", "a3"]);
  const tree = await store.getTree(id, project);
  assert.deepEqual(
    tree.filter((e) => !e.active).map((e) => e.id),
    ["u2", "a2"],
    "the abandoned branch is still in the log",
  );
  assert.equal(tree.find((e) => e.id === "u3")?.parentId, "a1");
  done();
});

test("navigating to the old branch's leaf switches back without losing either branch", async () => {
  const { store, id, done } = await rig();
  for (const m of [msg("u1", "user", "a"), msg("a1", "assistant", "b"), msg("u2", "user", "c")]) {
    await store.appendMessage(id, m, project);
  }
  await store.navigate(id, "a1", project);
  await store.appendMessage(id, msg("u3", "user", "d"), project);
  await store.navigate(id, "u2", project);
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u1", "a1", "u2"]);
  const nav = await store.navigate(id, "u3", project);
  assert.deepEqual(nav.abandoned.map((m) => m.id), ["u2"]);
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u1", "a1", "u3"]);
  // u3 is the last line: navigating to it drops the pointer.
  assert.equal((await store.getMeta(id, project))?.leafId, undefined);
  done();
});

test("a compacted log (dangling parentId) still yields a valid prefix", async () => {
  const { store, id, done } = await rig();
  for (const m of [msg("u1", "user", "a"), msg("a1", "assistant", "b")]) {
    await store.appendMessage(id, m, project);
  }
  await store.navigate(id, "u1", project);
  await store.appendMessage(id, msg("u2", "user", "c"), project); // parentId: u1
  await store.appendMessage(id, msg("a2", "assistant", "d"), project);
  // Compaction keeps the tail only.
  const tail = (await store.getMessages(id, project)).slice(-2);
  await store.replaceMessages(id, tail, project);
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u2", "a2"]);
  await store.appendMessage(id, msg("u3", "user", "e"), project);
  assert.deepEqual((await store.getMessages(id, project)).map((m) => m.id), ["u2", "a2", "u3"]);
  done();
});

test("labels and unknown ids", async () => {
  const { store, id, done } = await rig();
  await store.appendMessage(id, msg("u1", "user", "a"), project);
  await store.labelEntry(id, "u1", "good spot", project);
  assert.equal((await store.getTree(id, project))[0]?.label, "good spot");
  await store.labelEntry(id, "u1", "", project);
  assert.equal((await store.getTree(id, project))[0]?.label, undefined);
  await assert.rejects(() => store.navigate(id, "nope", project), /not found/);
  done();
});
