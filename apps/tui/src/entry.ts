#!/usr/bin/env node
// =============================================================================
// entry.ts — binary entry point
//
// The distributed `freecode` binary (bun --compile) bundles the TUI shell and
// the core backend. Core's createCli() owns the whole command surface (mcp,
// session, web, serve, …); this file only injects the frontend-specific
// commands: the TUI as the "$0" default, and `update`. Adding future backend
// commands never touches this file — register them in core's create-cli.ts.
//
// In dev (`tsx src/index.ts`) the TUI is launched directly and this file is
// not on the hot path; it only matters for the compiled binary.
// =============================================================================

// @ts-ignore — resolved via core's package.json exports map
import { createCli } from "@thisisayande/freecode-core/cli/create-cli";
// @ts-ignore — resolved via core's package.json exports map
import { formatFatalError } from "@thisisayande/freecode-core/cli/format-fatal-error";
import type { CommandModule } from "yargs";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// `bun build --compile` embeds the memory graph's onnxruntime native addon
// but not the shared library it dlopen()s at runtime (libonnxruntime.so.1 /
// .dylib — see build-bun.mjs, which ships it as a loose file next to this
// binary). The dynamic linker only reads LD_LIBRARY_PATH/DYLD_LIBRARY_PATH at
// process start, so setting it lazily right before the embedder needs it is
// too late — the whole process has to be re-exec'd with the variable already
// set. Do that once, here, before any real work starts; a sentinel env var
// stops this from looping. No-op on Windows (same-directory DLLs just work)
// and outside the compiled binary (dev's real .node file finds its sibling
// via its own RPATH, no help needed).
if (
  process.env.FREECODE_BUNDLED === "1" &&
  process.platform !== "win32" &&
  !process.env.__FREECODE_REEXECED
) {
  const libDir = path.dirname(process.execPath);
  const key = process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const existing = process.env[key];
  const env = {
    ...process.env,
    [key]: existing ? `${libDir}${path.delimiter}${existing}` : libDir,
    __FREECODE_REEXECED: "1",
  };
  const result = spawnSync(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    env,
  });
  process.exit(result.status ?? 1);
}

// Update handling lives in the TUI now (utils/update-check.ts), not here: an
// awaited GitHub round-trip in front of the TUI import put ~1.1s of blank
// terminal on every launch. Nothing self-installs any more either — the
// header shows a notice and `freecode update` below does the work.

// Cross-platform installer invocation. The bash installer at /install calls
// `err` and aborts on Windows (it expects `install.ps1` instead), so spawning
// `bash` on Windows always exits non-zero — the symptom was the `update
// failed` line and the TUI continuing on the old version. `powershell -NoProfile
// -ExecutionPolicy Bypass -Command "irm ... | iex"` runs install.ps1 via the
// standard `irm | iex` one-liner already documented on freecode.website.
function installerCommand(): string {
  return process.platform === "win32"
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://freecode.website/install.ps1 | iex"`
    : "curl -fsSL https://freecode.website/install | bash";
}

function runInstaller() {
  if (process.platform === "win32") {
    return spawnSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "irm https://freecode.website/install.ps1 | iex",
    ], { stdio: "inherit" });
  }
  return spawnSync("bash", ["-c", "curl -fsSL https://freecode.website/install | bash"], {
    stdio: "inherit",
  });
}
interface TuiArgs {
  project?: string;
  resume?: string;
}

const tuiCommand: CommandModule<object, TuiArgs> = {
  command: "$0 [project]",
  describe: "start the freecode TUI",
  builder: (yargs) =>
    yargs
      .positional("project", {
        describe: "project directory to open (defaults to current directory)",
        type: "string",
      })
      .option("resume", {
        alias: "r",
        // string with no value (`--resume`) opens the session picker; with an id
        // it resumes directly. index.ts reads this back off process.argv.
        describe: "resume a previous session by id (omit id to pick from a list)",
        type: "string",
      }),
  handler: async (argv) => {
    // Change to the specified project directory if provided
    if (argv.project) {
      const projectPath = path.resolve(argv.project);
      try {
        fs.accessSync(projectPath);
        process.chdir(projectPath);
      } catch {
        process.stderr.write(
          `[freecode] error: project directory not found: ${argv.project}\n`,
        );
        process.exit(1);
      }
    }

    // Lazy: importing runs the TUI (index.ts calls tui.start()), and the
    // other commands must not pay its startup cost.
    await import("./index.js");
  },
};

const updateCommand: CommandModule = {
  command: "update",
  describe: "update freecode to the latest release",
  handler: async () => {
    process.stderr.write(`[freecode] updating: ${installerCommand()}\n`);
    const r = runInstaller();
    process.exit(r.status ?? 0);
  },
};

// Background work (retries, fallback providers) can reject after the TUI's
// own awaited chain has resolved. Left unhandled, Bun's default reporter
// dumps the raw error object (every AI SDK field plus minified stack
// context); keep it on the same clean one-liner as the awaited failure.
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[freecode] fatal: ${formatFatalError(e)}\n`);
});

createCli([tuiCommand, updateCommand])
  .parseAsync()
  .catch((e: unknown) => {
    process.stderr.write(`[freecode] fatal: ${formatFatalError(e)}\n`);
    process.exit(1);
  });
