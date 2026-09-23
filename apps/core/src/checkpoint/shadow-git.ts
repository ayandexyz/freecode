// =============================================================================
// Shadow git — a snapshot store that never touches the project's own repo.
//
// Spec `2026-09-23-checkpoints-rewind.md` §3. A git directory under
// ~/.freecode/snapshots/<hash> whose WORK TREE is the real project root. Every
// command passes --git-dir and --work-tree explicitly, so the project's index,
// HEAD, stash, reflog and `git status` are untouched by a capture or a restore.
//
// A snapshot id IS a git tree id (§3.1): capture is `add -A` + `write-tree`,
// and `git checkout <tree> -- <paths>` restores from a bare tree, so there is
// no commit object, no parent chain and no branch to confuse anyone.
// =============================================================================

import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdir, rm, rmdir, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, relative, resolve, sep } from "path";
import { promisify } from "util";
import { logger } from "../utils/logger.js";

const exec = promisify(execFile);

/** opencode's number. An untracked file above this is left out of snapshots. */
export const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** A git tree id. */
export type SnapshotId = string;

export type FileChangeStatus = "modified" | "deleted" | "added";

export interface FileChange {
  /** Project-relative, forward-slashed. */
  path: string;
  /**
   * What happened to this path SINCE the snapshot — so restoring it performs
   * the inverse: `added` is deleted, `deleted` is recreated, `modified` is
   * rewritten.
   */
  status: FileChangeStatus;
}

function snapshotRoot(): string {
  return (
    process.env.FREECODE_SNAPSHOTS_HOME ??
    join(process.env.FREECODE_HOME ?? join(homedir(), ".freecode"), "snapshots")
  );
}

/** Stable per-project shadow dir; the hash keeps the path short and flat. */
export function shadowDirFor(projectRoot: string): string {
  const key = createHash("sha256")
    .update(resolve(projectRoot))
    .digest("hex")
    .slice(0, 16);
  return join(snapshotRoot(), key);
}

async function git(
  gitDir: string,
  workTree: string,
  args: string[],
): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["--git-dir", gitDir, "--work-tree", workTree, ...args],
    {
      cwd: workTree,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // A user's commit.gpgsign / hooks / templates have no business running
        // here, and an unset identity must not make write-tree fail.
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: process.env.HOME ?? homedir(),
      },
    },
  );
  return stdout;
}

/** True when `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export class ShadowGit {
  private readonly gitDir: string;
  private initialized = false;

  constructor(private readonly projectRoot: string) {
    this.gitDir = shadowDirFor(projectRoot);
  }

  private async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.gitDir), { recursive: true });
    try {
      await stat(join(this.gitDir, "HEAD"));
    } catch {
      await mkdir(this.gitDir, { recursive: true });
      await git(this.gitDir, this.projectRoot, ["init", "-q"]);
    }
    this.initialized = true;
  }

  /**
   * Snapshot the work tree. Returns a tree id, or undefined when the capture
   * failed — a capture is best-effort and never fails the caller's turn
   * (spec §4.1).
   */
  async capture(): Promise<SnapshotId | undefined> {
    try {
      await this.ensureRepo();
      // `add -A` honours the PROJECT's .gitignore (that is why §3.2 requires a
      // git repo) and always skips a nested .git. The size guard keeps a stray
      // build artifact out; a tracked file is added regardless, because
      // dropping it would make restore silently incomplete.
      await git(this.gitDir, this.projectRoot, [
        "add",
        "-A",
        ...(await this.oversizeExclusions()),
      ]);
      const tree = (
        await git(this.gitDir, this.projectRoot, ["write-tree"])
      ).trim();
      return tree || undefined;
    } catch (err) {
      logger.warn("[Checkpoint] capture failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Pathspecs excluding untracked files over MAX_UNTRACKED_BYTES. Returns []
   * when there are none, which is the overwhelmingly common case.
   */
  private async oversizeExclusions(): Promise<string[]> {
    let untracked: string[];
    try {
      const out = await git(this.gitDir, this.projectRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      untracked = out.split("\0").filter(Boolean);
    } catch {
      return [];
    }
    const excluded: string[] = [];
    for (const path of untracked) {
      try {
        const info = await stat(join(this.projectRoot, path));
        if (info.isFile() && info.size > MAX_UNTRACKED_BYTES) {
          excluded.push(`:(exclude)${path}`);
        }
      } catch {
        // Vanished between listing and stat — nothing to exclude.
      }
    }
    return excluded;
  }

  /**
   * What changed between `from` and the current work tree, as the inverse
   * operations a restore would apply (spec §4.2).
   */
  async changesSince(from: SnapshotId): Promise<FileChange[]> {
    const current = await this.capture();
    if (!current) return [];
    return this.diff(from, current);
  }

  async diff(from: SnapshotId, to: SnapshotId): Promise<FileChange[]> {
    await this.ensureRepo();
    const out = await git(this.gitDir, this.projectRoot, [
      "diff",
      "--name-status",
      "-z",
      from,
      to,
    ]);
    // -z output is NUL-separated: STATUS \0 PATH \0 STATUS \0 PATH ...
    const fields = out.split("\0").filter((f) => f !== "");
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const code = fields[i]![0];
      const path = fields[i + 1]!;
      const status: FileChangeStatus | undefined =
        code === "A"
          ? "added"
          : code === "D"
            ? "deleted"
            : code === "M" || code === "T"
              ? "modified"
              : undefined;
      if (status) changes.push({ path, status });
    }
    return changes;
  }

  /**
   * Restore the given paths to their state in `snapshot`. Paths outside the
   * project root are refused — a snapshot's authority stops at its work tree.
   */
  async restore(
    snapshot: SnapshotId,
    changes: FileChange[],
  ): Promise<FileChange[]> {
    if (changes.length === 0) return [];
    await this.ensureRepo();

    const safe = changes.filter((c) => this.within(c.path));
    const toCheckout = safe
      .filter((c) => c.status !== "added")
      .map((c) => c.path);
    const toDelete = safe
      .filter((c) => c.status === "added")
      .map((c) => c.path);

    if (toCheckout.length > 0) {
      // Chunked: a turn that rewrote thousands of files would otherwise blow
      // the argument limit.
      for (let i = 0; i < toCheckout.length; i += 500) {
        await git(this.gitDir, this.projectRoot, [
          "checkout",
          snapshot,
          "--",
          ...toCheckout.slice(i, i + 500),
        ]);
      }
    }

    for (const path of toDelete) {
      const abs = join(this.projectRoot, path);
      await rm(abs, { force: true });
      await this.pruneEmptyParents(dirname(abs));
    }

    return safe;
  }

  /** Remove directories the delete emptied, bottom-up, never past the root. */
  private async pruneEmptyParents(dir: string): Promise<void> {
    let current = dir;
    while (
      this.within(relative(this.projectRoot, current)) &&
      current !== this.projectRoot
    ) {
      try {
        await rmdir(current); // throws ENOTEMPTY when it still holds anything
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  /** Project-relative path that does not escape the root. */
  private within(path: string): boolean {
    if (path === "" || path === ".") return false;
    const rel = relative(this.projectRoot, resolve(this.projectRoot, path));
    return (
      rel !== "" &&
      !rel.startsWith("..") &&
      !rel.startsWith(sep) &&
      !/^[a-zA-Z]:/.test(rel)
    );
  }
}
