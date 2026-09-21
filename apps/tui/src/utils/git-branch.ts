import { readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * The checked-out branch of the repo containing `cwd`, or null outside one.
 * Read from `.git/HEAD` rather than by spawning git: the composer prompt
 * re-renders on every keystroke, and a file read is microseconds where a
 * process is milliseconds. A detached HEAD reports its short sha.
 *
 * A worktree's `.git` is a file (`gitdir: <path>`), not a directory, so it is
 * followed one hop before HEAD is read.
 */
export function readGitBranch(cwd: string = process.cwd()): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    let gitDir: string | null = null;
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) gitDir = dotGit;
      else {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (m?.[1]) gitDir = resolve(dir, m[1].trim());
      }
    } catch {
      // not here — keep walking up
    }
    if (gitDir) {
      let head: string;
      try {
        head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      } catch {
        return null;
      }
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref?.[1] ?? head.slice(0, 7);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
