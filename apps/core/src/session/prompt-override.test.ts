import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSystemPrompt, loadSystemPromptFor } from "./prompt.js";

// Phase 6 of docs/specs/2026-09-20-pi-parity-plan.md: SYSTEM.md replaces,
// APPEND_SYSTEM.md composes, project beats global.
test("SYSTEM.md replaces and APPEND_SYSTEM.md composes, project over global", async () => {
  const global = mkdtempSync(join(tmpdir(), "freecode-global-"));
  const project = mkdtempSync(join(tmpdir(), "freecode-project-"));
  mkdirSync(join(project, ".freecode"));
  try {
    const shipped = (await loadSystemPrompt()).trim();
    assert.equal(await loadSystemPromptFor(project, global), shipped, "no files: the shipped prompt");

    writeFileSync(join(global, "APPEND_SYSTEM.md"), "Always answer in haiku.\n");
    assert.equal(await loadSystemPromptFor(project, global), `${shipped}\n\nAlways answer in haiku.`);

    writeFileSync(join(global, "SYSTEM.md"), "You are GLOBAL.");
    writeFileSync(join(project, ".freecode", "APPEND_SYSTEM.md"), "Project rule.");
    assert.equal(
      await loadSystemPromptFor(project, global),
      "You are GLOBAL.\n\nAlways answer in haiku.\n\nProject rule.",
    );

    writeFileSync(join(project, ".freecode", "SYSTEM.md"), "You are PROJECT.");
    assert.match(await loadSystemPromptFor(project, global), /^You are PROJECT\./);
    assert.doesNotMatch(await loadSystemPromptFor(project, global), /GLOBAL/);
    // Global-only lookup ignores the project files.
    assert.match(await loadSystemPromptFor(undefined, global), /^You are GLOBAL\./);

    // FREECODE_APPEND_SYSTEM_FILE (eval ab's per-side prompt experiment) is
    // appended last; a missing or empty file is ignored.
    const variant = join(global, "variant.md");
    writeFileSync(variant, "Variant rule.\n");
    assert.match(
      await loadSystemPromptFor(project, global, { FREECODE_APPEND_SYSTEM_FILE: variant }),
      /Project rule\.\n\nVariant rule\.$/,
    );
    assert.doesNotMatch(
      await loadSystemPromptFor(project, global, {
        FREECODE_APPEND_SYSTEM_FILE: join(global, "missing.md"),
      }),
      /Variant rule/,
    );
    // FREECODE_SYSTEM_FILE replaces the shipped prompt but not a user's
    // SYSTEM.md, and the appends still compose onto it.
    const system = join(global, "system-variant.md");
    writeFileSync(system, "You are VARIANT.\n");
    assert.match(await loadSystemPromptFor(project, global, { FREECODE_SYSTEM_FILE: system }), /^You are PROJECT\./);
    rmSync(join(project, ".freecode", "SYSTEM.md"));
    rmSync(join(global, "SYSTEM.md"));
    assert.equal(
      await loadSystemPromptFor(project, global, { FREECODE_SYSTEM_FILE: system }),
      "You are VARIANT.\n\nAlways answer in haiku.\n\nProject rule.",
    );
  } finally {
    rmSync(global, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
