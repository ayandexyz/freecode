import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AbReport } from "./ab-run.js";

export interface AbProvenance {
  commit: string;
  dirty: boolean;
  /** Hash of HEAD, tracked diff, and untracked file contents; no source is stored. */
  treeHash: string;
}

export function captureAbProvenance(
  cwd = process.cwd(),
): AbProvenance | undefined {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    const root = git(["rev-parse", "--show-toplevel"]).toString().trim();
    const commit = git(["rev-parse", "HEAD"]).toString().trim();
    const diff = git(["diff", "--binary", "--no-ext-diff", "HEAD", "--", ":/"]);
    const untracked = git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
      "--",
      ":/",
    ])
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256").update(commit).update("\0").update(diff);
    for (const file of untracked) {
      const absolute = path.join(root, file);
      const content = fs.lstatSync(absolute).isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(absolute))
        : fs.readFileSync(absolute);
      hash
        .update("\0")
        .update(file)
        .update("\0")
        .update(String(content.length))
        .update("\0")
        .update(content);
    }
    return {
      commit,
      dirty: diff.length > 0 || untracked.length > 0,
      treeHash: hash.digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export function saveAbReport(
  report: AbReport,
  directory = path.join(os.homedir(), ".freecode", "eval-ab"),
): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return file;
}
