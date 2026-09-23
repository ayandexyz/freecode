// =============================================================================
// Shadow git — the invariant under test is that the project's OWN repo is
// never touched (spec 2026-09-23-checkpoints-rewind §3), and that a restore
// puts back exactly what the turn changed and nothing else.
// =============================================================================

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { ShadowGit, isGitRepo, shadowDirFor } from "./shadow-git.js";

let root: string;
let proj: string;
let snapshotsHome: string;
const originalHome = process.env.FREECODE_SNAPSHOTS_HOME;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: proj, encoding: "utf-8" });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "freecode-cp-"));
});

after(() => {
  if (originalHome === undefined) delete process.env.FREECODE_SNAPSHOTS_HOME;
  else process.env.FREECODE_SNAPSHOTS_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  proj = mkdtempSync(join(root, "proj-"));
  snapshotsHome = mkdtempSync(join(root, "snap-"));
  process.env.FREECODE_SNAPSHOTS_HOME = snapshotsHome;
  git("init", "-q", ".");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(proj, ".gitignore"), "node_modules\n");
  mkdirSync(join(proj, "node_modules"), { recursive: true });
  writeFileSync(join(proj, "node_modules", "junk"), "x");
  writeFileSync(join(proj, "a.txt"), "v1\n");
  writeFileSync(join(proj, "b.txt"), "keep\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

describe("ShadowGit", () => {
  it("captures a tree and reports what a turn changed", async () => {
    const shadow = new ShadowGit(proj);
    const snap = await shadow.capture();
    assert.ok(snap, "expected a tree id");

    writeFileSync(join(proj, "a.txt"), "v2 modified\n");
    writeFileSync(join(proj, "c.txt"), "new\n");
    rmSync(join(proj, "b.txt"));

    const changes = await shadow.changesSince(snap!);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    assert.deepEqual(byPath, {
      "a.txt": "modified",
      "b.txt": "deleted",
      "c.txt": "added",
    });
  });

  it("restores modified, deleted and added files", async () => {
    const shadow = new ShadowGit(proj);
    const snap = (await shadow.capture())!;

    writeFileSync(join(proj, "a.txt"), "v2 modified\n");
    writeFileSync(join(proj, "c.txt"), "new\n");
    rmSync(join(proj, "b.txt"));

    const changes = await shadow.changesSince(snap);
    await shadow.restore(snap, changes);

    assert.equal(
      readFileSync(join(proj, "a.txt"), "utf-8"),
      "v1\n",
      "modified reverted",
    );
    assert.equal(
      readFileSync(join(proj, "b.txt"), "utf-8"),
      "keep\n",
      "deleted restored",
    );
    assert.equal(existsSync(join(proj, "c.txt")), false, "added file removed");
  });

  it("leaves the project's own git state untouched", async () => {
    const headBefore = git("rev-parse", "HEAD").trim();
    const statusBefore = git("status", "--porcelain");

    const shadow = new ShadowGit(proj);
    const snap = (await shadow.capture())!;
    writeFileSync(join(proj, "a.txt"), "v2\n");
    await shadow.restore(snap, await shadow.changesSince(snap));

    assert.equal(git("rev-parse", "HEAD").trim(), headBefore, "HEAD moved");
    assert.equal(
      git("status", "--porcelain"),
      statusBefore,
      "working tree dirty",
    );
    // The shadow repo must live outside the project.
    assert.ok(!shadowDirFor(proj).startsWith(proj));
  });

  it("does not snapshot gitignored paths", async () => {
    const shadow = new ShadowGit(proj);
    const snap = (await shadow.capture())!;
    writeFileSync(join(proj, "node_modules", "junk"), "changed");
    const changes = await shadow.changesSince(snap);
    assert.deepEqual(changes, [], "ignored file leaked into the snapshot");
    // And a restore leaves it alone.
    assert.equal(
      readFileSync(join(proj, "node_modules", "junk"), "utf-8"),
      "changed",
    );
  });

  it("leaves untouched files alone even when they changed since the snapshot", async () => {
    const shadow = new ShadowGit(proj);
    const snap = (await shadow.capture())!;
    writeFileSync(join(proj, "a.txt"), "agent edit\n");
    const changes = await shadow.changesSince(snap);
    // A second snapshot taken later is what restore diffs against, so a file
    // the user edits by hand AFTER the diff is computed is not in the plan.
    writeFileSync(join(proj, "b.txt"), "hand edit by the user\n");
    await shadow.restore(snap, changes);
    assert.equal(
      readFileSync(join(proj, "b.txt"), "utf-8"),
      "hand edit by the user\n",
      "a path outside the plan was overwritten",
    );
  });

  it("removes directories the restore emptied", async () => {
    const shadow = new ShadowGit(proj);
    const snap = (await shadow.capture())!;
    mkdirSync(join(proj, "gen", "deep"), { recursive: true });
    writeFileSync(join(proj, "gen", "deep", "out.txt"), "generated\n");
    await shadow.restore(snap, await shadow.changesSince(snap));
    assert.equal(
      existsSync(join(proj, "gen")),
      false,
      "empty dirs left behind",
    );
  });

  it("reports a non-repo as unusable", async () => {
    const plain = mkdtempSync(join(root, "plain-"));
    assert.equal(await isGitRepo(plain), false);
    assert.equal(await isGitRepo(proj), true);
  });
});
