// =============================================================================
// `freecode checkpoint` — inspect and prune the working-tree snapshots that
// back `/rewind` (spec 2026-09-23-checkpoints-rewind §6).
//
// `gc` is a separate command rather than something the turn path does, because
// `git gc` walks every object and this feature's whole premise is that taking a
// checkpoint costs the user nothing they can feel.
// =============================================================================

import { execFile } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import type { CommandModule } from "yargs";
import { shadowDirFor } from "../../checkpoint/index.js";

const exec = promisify(execFile);

function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // raced with gc
        }
      }
    }
  };
  walk(dir);
  return total;
}

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

interface CheckpointArgs {
  project?: string;
}

export const checkpointCommand: CommandModule<object, CheckpointArgs> = {
  command: "checkpoint <action>",
  describe: "Inspect or prune the snapshot store behind /rewind",
  builder: (yargs) =>
    yargs
      .positional("action", {
        choices: ["status", "gc"] as const,
        describe:
          "status: where the store is and how big. gc: prune loose objects.",
      })
      .option("project", {
        type: "string",
        describe: "Project root (defaults to the current directory)",
      }) as never,
  handler: async (argv) => {
    const project = argv.project ?? process.cwd();
    const dir = shadowDirFor(project);
    const action = (argv as unknown as { action: string }).action;

    if (!fs.existsSync(dir)) {
      console.log(`No snapshot store for ${project}`);
      console.log(`(it would live at ${dir})`);
      return;
    }

    if (action === "status") {
      console.log(`Project:  ${project}`);
      console.log(`Store:    ${dir}`);
      console.log(`Size:     ${human(dirSizeBytes(dir))}`);
      return;
    }

    const before = dirSizeBytes(dir);
    // The shadow repo has no refs, so every snapshot tree is unreachable by
    // design — `--prune=now` with no reflog to protect them is the point.
    await exec("git", ["--git-dir", dir, "gc", "--prune=now", "--quiet"], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const after = dirSizeBytes(dir);
    console.log(
      `Pruned ${dir}\n${human(before)} → ${human(after)} (freed ${human(Math.max(0, before - after))})`,
    );
    console.log(
      "\nNote: this discards every snapshot, so /rewind can no longer restore\n" +
        "files for existing sessions. The conversation history is untouched.",
    );
  },
};
