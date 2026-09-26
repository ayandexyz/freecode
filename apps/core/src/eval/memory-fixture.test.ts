import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "memfix-home-"));

import { MemoryStore } from "../memory/mem-store.js";
import { seedMemories } from "./memory-fixture.js";

test("seeds exactly the fixture into the project's own store, and removes it", async () => {
  const project = mkdtempSync(join(tmpdir(), "memfix-proj-"));
  try {
    const cleanup = await seedMemories(project, [
      {
        type: "project",
        name: "uses-pnpm",
        description: "package manager",
        content: "Use pnpm.",
        tags: ["tooling"],
      },
      { type: "feedback", name: "no-force-push", description: "git", content: "Never force-push." },
    ]);
    const store = new MemoryStore(project);
    const names = store.list().map((e) => `${e.type}/${e.name}`).sort();
    assert.deepEqual(names, ["feedback/no-force-push", "project/uses-pnpm"]);
    assert.deepEqual(store.load("uses-pnpm", "project")?.tags, ["tooling"]);

    cleanup();
    assert.equal(existsSync(store.getMemoryDir()), false);
    assert.deepEqual(new MemoryStore(project).list(), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("two projects never share a fixture", async () => {
  const a = mkdtempSync(join(tmpdir(), "memfix-a-"));
  const b = mkdtempSync(join(tmpdir(), "memfix-b-"));
  try {
    const cleanup = await seedMemories(a, [
      { type: "project", name: "only-in-a", description: "d", content: "c" },
    ]);
    assert.deepEqual(new MemoryStore(b).list(), []);
    cleanup();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("the index is built at seed time, so the first request is not a cold miss", async () => {
  const project = mkdtempSync(join(tmpdir(), "memfix-warm-"));
  try {
    const cleanup = await seedMemories(project, [
      {
        type: "project",
        name: "uses-pnpm",
        description: "This repo uses pnpm as its package manager",
        content: "Install dependencies with pnpm install.",
      },
    ]);
    const { getMemoryGraphService } = await import("../memory/graph/index.js");
    const service = getMemoryGraphService(project);
    const first = await service.prepareMemories(
      "s",
      "which package manager do we use to install dependencies",
    );
    assert.deepEqual(first.map((e) => e.name), ["uses-pnpm"]);
    assert.equal(service.preparationFor("s").state, "fresh");
    cleanup();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
