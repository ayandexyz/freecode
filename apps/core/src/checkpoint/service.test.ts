// =============================================================================
// CheckpointService — capture is best-effort and keyed by entry id; restore is
// explicit and reports. Spec 2026-09-23-checkpoints-rewind §4/§8.
// =============================================================================

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { CheckpointService } from "./service.js";
import {
  resolveCheckpointSettings,
  DEFAULT_CHECKPOINT_SETTINGS,
} from "./settings.js";

let root: string;
let proj: string;
const saved = {
  snapshots: process.env.FREECODE_SNAPSHOTS_HOME,
  home: process.env.FREECODE_HOME,
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "freecode-cps-"));
});

after(() => {
  for (const [key, value] of [
    ["FREECODE_SNAPSHOTS_HOME", saved.snapshots],
    ["FREECODE_HOME", saved.home],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  proj = mkdtempSync(join(root, "proj-"));
  process.env.FREECODE_SNAPSHOTS_HOME = mkdtempSync(join(root, "snap-"));
  process.env.FREECODE_HOME = mkdtempSync(join(root, "home-"));
  execFileSync("git", ["init", "-q", "."], { cwd: proj });
  writeFileSync(join(proj, "a.txt"), "v1\n");
});

describe("CheckpointService", () => {
  it("captures, lists and restores a turn's changes", async () => {
    const service = new CheckpointService("sess-1", proj);
    const capture = await service.capture("entry-1", "  fix the   parser  ");
    assert.ok(capture.snapshot, `expected a snapshot, got ${capture.skipped}`);

    const listed = await service.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.entryId, "entry-1");
    assert.equal(
      listed[0]!.preview,
      "fix the parser",
      "preview not normalized",
    );

    writeFileSync(join(proj, "a.txt"), "the agent broke it\n");
    const preview = await service.preview("entry-1");
    assert.deepEqual(preview, [{ path: "a.txt", status: "modified" }]);
    // preview() must not have written anything.
    assert.equal(
      readFileSync(join(proj, "a.txt"), "utf-8"),
      "the agent broke it\n",
    );

    const result = await service.restore("entry-1");
    assert.equal(result.restored.length, 1);
    assert.deepEqual(result.skipped, []);
    assert.equal(readFileSync(join(proj, "a.txt"), "utf-8"), "v1\n");
  });

  it("skips a project that is not a git repository, without throwing", async () => {
    const plain = mkdtempSync(join(root, "plain-"));
    const service = new CheckpointService("sess-2", plain);
    const result = await service.capture("entry-1", "hello");
    assert.equal(result.snapshot, undefined);
    assert.equal(result.skipped, "not_a_git_repo");
    assert.deepEqual(await service.list(), []);
  });

  it("skips when disabled", async () => {
    const service = new CheckpointService("sess-3", proj, {
      enabled: false,
      maxPerSession: 100,
    });
    assert.equal((await service.capture("e", "p")).skipped, "disabled");
  });

  it("refuses to restore a message it has no checkpoint for", async () => {
    const service = new CheckpointService("sess-4", proj);
    await assert.rejects(
      () => service.restore("never-captured"),
      /No checkpoint for message never-captured/,
    );
  });

  it("trims to maxPerSession, keeping the most recent", async () => {
    const service = new CheckpointService("sess-5", proj, {
      enabled: true,
      maxPerSession: 3,
    });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(proj, "a.txt"), `v${i}\n`);
      await service.capture(`entry-${i}`, `turn ${i}`);
    }
    const listed = await service.list();
    assert.deepEqual(
      listed.map((c) => c.entryId),
      ["entry-2", "entry-3", "entry-4"],
    );
  });

  it("re-capturing the same entry id replaces rather than duplicates", async () => {
    const service = new CheckpointService("sess-6", proj);
    await service.capture("entry-1", "first");
    await service.capture("entry-1", "second");
    const listed = await service.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.preview, "second");
  });
});

describe("checkpoint settings", () => {
  it("defaults to on — it does not change what the model does (§8)", () => {
    assert.equal(DEFAULT_CHECKPOINT_SETTINGS.enabled, true);
    assert.equal(resolveCheckpointSettings([], {}).enabled, true);
  });

  it("project scope beats user scope", () => {
    const resolved = resolveCheckpointSettings(
      [{ maxPerSession: 10 }, { maxPerSession: 99, enabled: false }],
      {},
    );
    assert.equal(resolved.maxPerSession, 10);
    assert.equal(resolved.enabled, false);
  });

  it("FREECODE_CHECKPOINTS beats the files, both ways", () => {
    assert.equal(
      resolveCheckpointSettings([{ enabled: true }], {
        FREECODE_CHECKPOINTS: "0",
      }).enabled,
      false,
    );
    assert.equal(
      resolveCheckpointSettings([{ enabled: false }], {
        FREECODE_CHECKPOINTS: "1",
      }).enabled,
      true,
    );
  });
});
