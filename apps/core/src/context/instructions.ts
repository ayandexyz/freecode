// =============================================================================
// Project Instructions Loader
// Reads user-authored instruction files into the system prompt.
// Per location, CLAUDE.md wins over AGENTS.md (first non-empty match only).
// Locations, in prompt order: global (~/.freecode/), then project root.
// ponytail: root-level files only; walk-up hierarchy / @imports deferred
// until monorepo users ask (see plan doc Notes).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
const SEPARATOR = "\n\n";

function readFirstMatch(
  dir: string,
): { path: string; content: string } | undefined {
  for (const name of INSTRUCTION_FILES) {
    const filePath = path.join(dir, name);
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) return { path: filePath, content };
    } catch {
      // missing/unreadable — try the next candidate
    }
  }
  return undefined;
}

/**
 * Render the project-instructions section for the system prompt.
 * Returns "" when no instruction files exist.
 */
export function compileInstructionsSection(
  projectPath: string,
  globalDir: string = path.join(os.homedir(), ".freecode"),
): string {
  const found = [readFirstMatch(globalDir), readFirstMatch(projectPath)].filter(
    (f): f is { path: string; content: string } => f !== undefined,
  );
  if (found.length === 0) return "";

  // No size cap: the user wrote it, so send it whole. A 40k-char budget used
  // to slice the project file mid-word here; opencode/pi/jcode all send the
  // file in full and the tokens are prompt-cached after the first turn.
  return found
    .map((f) => `Instructions from: ${f.path}\n${f.content}`)
    .join(SEPARATOR);
}
