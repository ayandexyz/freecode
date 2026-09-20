// Extensions (spec 2026-09-20-pi-parity-plan, Phase 5): a file's default
// export registers tools, commands and hooks; a reload takes the old ones
// out first; a throwing factory leaves nothing behind; project files load
// only for a trusted project.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionFile, unloadAllExtensions, extensionFiles } from "./loader.js";
import { getTool, listTools } from "../tools/index.js";
import { toolKind } from "../permission/mode-policy.js";
import { resolveCommand } from "../commands/registry.js";
import { getHooksForEvent as getHooks } from "../hooks/registry.js";

const EXT = `
export default function (api) {
  api.registerTool({
    name: "ext_echo",
    description: "Echo the input",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    readOnly: true,
    execute: async (args) => "echo: " + args.text,
  });
  api.registerCommand({
    name: "ext-hello",
    description: "Say hello",
    prompt: ({ args }) => "Hello " + args.join(" "),
  });
  api.on("PreToolUse", async () => ({ action: "continue" }), { matcher: "ext_echo" });
}
`;

test("an extension registers a tool, a command and a hook; reload replaces them; unload removes them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-ext-"));
  const file = join(dir, "hello.mjs");
  writeFileSync(file, EXT);
  try {
    const first = await loadExtensionFile(file, "user");
    assert.equal(first.error, undefined);
    assert.deepEqual(first.tools, ["ext_echo"]);
    assert.deepEqual(first.commands, ["ext-hello"]);
    assert.equal(first.hooks.length, 1);

    const tool = getTool("ext_echo");
    assert.ok(tool, "registered in the tool registry");
    const result = await tool!.execute({ text: "hi" }, { cwd: dir });
    assert.equal((result as { output: string }).output, "echo: hi");
    assert.ok(listTools().some((t) => t.id === "ext_echo"), "offered to the model");
    assert.equal(toolKind("ext_echo"), "readonly", "readOnly claim reaches mode policy");
    assert.equal(await resolveCommand("ext-hello", ["world"], dir, dir), "Hello world");
    assert.equal(getHooks("PreToolUse").filter((h) => h.name.startsWith("ext:hello.mjs")).length, 1);

    // Reload: the file changed; the old registrations are gone, the new ones in.
    writeFileSync(file, EXT.replace('"echo: "', '"ECHO: "'));
    const second = await loadExtensionFile(file, "user");
    assert.equal(second.error, undefined);
    const again = await getTool("ext_echo")!.execute({ text: "hi" }, { cwd: dir });
    assert.equal((again as { output: string }).output, "ECHO: hi");
    assert.equal(getHooks("PreToolUse").filter((h) => h.name.startsWith("ext:hello.mjs")).length, 1, "hooks not doubled");

    unloadAllExtensions();
    assert.equal(getTool("ext_echo"), undefined);
    assert.equal(toolKind("ext_echo"), "mutating");
    assert.equal(await resolveCommand("ext-hello", [], dir, dir), null);
    assert.equal(getHooks("PreToolUse").filter((h) => h.name.startsWith("ext:hello.mjs")).length, 0);
  } finally {
    unloadAllExtensions();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a factory that throws after registering leaves nothing registered and reports the error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-ext-"));
  const file = join(dir, "broken.mjs");
  writeFileSync(
    file,
    `export default function (api) {
      api.registerCommand({ name: "ext-broken", description: "x", prompt: () => "x" });
      throw new Error("boom");
    }`,
  );
  try {
    const rec = await loadExtensionFile(file, "user");
    assert.match(rec.error ?? "", /boom/);
    assert.equal(await resolveCommand("ext-broken", [], dir, dir), null);
  } finally {
    unloadAllExtensions();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extension cannot shadow a built-in tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-ext-"));
  const file = join(dir, "shadow.mjs");
  writeFileSync(
    file,
    `export default function (api) {
      api.registerTool({ name: "bash", description: "x", parameters: { type: "object", properties: {} }, execute: async () => "" });
    }`,
  );
  try {
    const rec = await loadExtensionFile(file, "user");
    assert.match(rec.error ?? "", /collides with a built-in/);
    assert.equal(getTool("bash")!.id, "bash");
  } finally {
    unloadAllExtensions();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project extensions are discovered only for a trusted project", () => {
  const home = mkdtempSync(join(tmpdir(), "freecode-home-"));
  const project = mkdtempSync(join(tmpdir(), "freecode-proj-"));
  mkdirSync(join(home, ".freecode", "extensions"), { recursive: true });
  mkdirSync(join(project, ".freecode", "extensions"), { recursive: true });
  writeFileSync(join(home, ".freecode", "extensions", "u.mjs"), "export default () => {}");
  writeFileSync(join(project, ".freecode", "extensions", "p.mjs"), "export default () => {}");
  const prevTrust = process.env.FREECODE_TRUST_PROJECT_EXTENSIONS;
  try {
    delete process.env.FREECODE_TRUST_PROJECT_EXTENSIONS;
    assert.deepEqual(
      extensionFiles(project, home).map((f) => f.scope),
      ["user"],
      "untrusted project: user files only",
    );
    process.env.FREECODE_TRUST_PROJECT_EXTENSIONS = "1";
    assert.deepEqual(
      extensionFiles(project, home).map((f) => f.scope),
      ["user", "project"],
    );
  } finally {
    if (prevTrust === undefined) delete process.env.FREECODE_TRUST_PROJECT_EXTENSIONS;
    else process.env.FREECODE_TRUST_PROJECT_EXTENSIONS = prevTrust;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
