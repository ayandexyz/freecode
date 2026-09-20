// =============================================================================
// System Prompt Loader
// Loads the single, provider-agnostic FreeCode system prompt from
// session/prompt/system.md. Per-model identity ("You are powered by ...") is
// injected separately by the prompt compiler, so one prompt serves every model.
//
// Two runtimes to satisfy:
//   - dev (tsx): the .md sits on disk next to this file — read it directly so
//     edits are picked up without a rebuild.
//   - bundled single-file binary (`bun build --compile`): nothing is on disk,
//     so the prompt is embedded via a static-specifier text import, which bun
//     bakes into the executable. (Node/tsx can't execute a text import, which
//     is why the fs read comes first and this is only reached in the binary.)
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPT_FILE = "system.md";

// Ultimate fallback if neither the on-disk file nor the embedded copy is found.
const EMBEDDED_FALLBACK =
  "You are FreeCode, an AI coding assistant CLI. Complete the user's task.";

let cached: string | undefined;

// User overrides (spec 2026-09-20-pi-parity-plan, Phase 6; pi's SYSTEM.md /
// APPEND_SYSTEM.md). `SYSTEM.md` replaces the shipped prompt outright —
// project (`<project>/.freecode/SYSTEM.md`) over global (`~/.freecode/`).
// `APPEND_SYSTEM.md` is added after it, global then project, and composes
// with a replacement. Read every call so an edit lands on the next turn,
// like CLAUDE.md; the shipped prompt itself stays cached.
const OVERRIDE_FILE = "SYSTEM.md";
const APPEND_FILE = "APPEND_SYSTEM.md";

function readTrimmed(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf-8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shipped prompt with the user's SYSTEM.md / APPEND_SYSTEM.md applied.
 * `projectPath` undefined means global overrides only.
 */
export async function loadSystemPromptFor(
  projectPath: string | undefined,
  globalDir: string = path.join(os.homedir(), ".freecode"),
): Promise<string> {
  const projectDir = projectPath ? path.join(projectPath, ".freecode") : undefined;
  const replacement =
    (projectDir && readTrimmed(path.join(projectDir, OVERRIDE_FILE))) ??
    readTrimmed(path.join(globalDir, OVERRIDE_FILE));
  const base = replacement ?? (await loadSystemPrompt()).trim();
  const appended = [
    readTrimmed(path.join(globalDir, APPEND_FILE)),
    projectDir ? readTrimmed(path.join(projectDir, APPEND_FILE)) : undefined,
  ].filter((s): s is string => Boolean(s));
  return [base, ...appended].join("\n\n");
}

/**
 * Load the canonical FreeCode system prompt. Cached after the first read.
 */
export async function loadSystemPrompt(): Promise<string> {
  if (cached !== undefined) return cached;

  // dev / on-disk: read the live file.
  try {
    cached = fs.readFileSync(
      path.join(__dirname, "prompt", PROMPT_FILE),
      "utf-8",
    );
    return cached;
  } catch {
    // Not on disk — expected inside the compiled single-file binary.
  }

  // bundled binary: the prompt is embedded via this text import.
  try {
    // @ts-ignore - bun's text loader; resolved at build time, no Node analog.
    const mod = (await import("./prompt/system.md", {
      with: { type: "text" },
    })) as { default: string };
    cached = mod.default;
    return cached;
  } catch {
    // Fall through to the embedded minimal prompt.
  }

  // Reaching here means the agent runs with a one-line prompt: no tool
  // guidance, no coding standards, no mode behaviour. It degrades quality
  // invisibly instead of failing, so it stayed unnoticed until a session
  // showed the model ignoring instructions that were never sent. Say so.
  logger.warn(
    `[prompt] ${PROMPT_FILE} not found on disk or embedded — falling back to a ` +
      `minimal ${EMBEDDED_FALLBACK.length}-character system prompt. The agent ` +
      `will behave noticeably worse. In the monorepo this means dist is stale ` +
      `or missing assets: run \`pnpm --filter @thisisayande/freecode-core build\`.`,
  );
  cached = EMBEDDED_FALLBACK;
  return cached;
}
