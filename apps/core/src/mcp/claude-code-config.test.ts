import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expandEnvVars,
  loadClaudeCodeMcpServers,
  toMcpServer,
} from "./claude-code-config.js";
import { loadMcpConfig } from "./config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-"));
}

test("expandEnvVars expands ${VAR} and ${VAR:-default}", () => {
  assert.equal(expandEnvVars("${A}/${B:-dflt}/${C}", { A: "x" }), "x/dflt/");
});

test("toMcpServer maps stdio entries to local", () => {
  const s = toMcpServer("s", { command: "npx", args: ["-y", "pkg"], env: { K: "v" } });
  assert.deepEqual(s, {
    name: "s",
    type: "local",
    command: ["npx"],
    args: ["-y", "pkg"],
    env: { K: "v" },
    enabled: true,
    timeout: 5000,
    source: "claude-code",
  });
});

test("toMcpServer maps http/sse entries to remote", () => {
  const http = toMcpServer("r", { type: "http", url: "https://x/mcp" });
  assert.equal(http?.type, "remote");
  assert.equal(http?.url, "https://x/mcp");
  assert.equal(toMcpServer("r", { type: "sse", url: "https://x/sse" })?.type, "remote");
});

test("toMcpServer drops entries with neither command nor url", () => {
  assert.equal(toMcpServer("bad", {}), null);
  assert.equal(toMcpServer("bad", { type: "http" }), null);
});

test("loadClaudeCodeMcpServers merges repo > project > user and honours disabledMcpjsonServers", () => {
  const home = tmp();
  const project = tmp();
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { shared: { command: "user-cmd" }, userOnly: { command: "u" } },
      projects: {
        [project]: {
          mcpServers: { shared: { command: "project-cmd" } },
          disabledMcpjsonServers: ["off"],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: { shared: { command: "repo-cmd" }, off: { command: "never" } },
    }),
  );

  const servers = loadClaudeCodeMcpServers(project, home);
  assert.deepEqual(servers.map((s) => s.name).sort(), ["shared", "userOnly"]);
  assert.deepEqual(servers.find((s) => s.name === "shared")?.command, ["repo-cmd"]);
});

test("loadClaudeCodeMcpServers returns nothing when no Claude Code config exists", () => {
  assert.deepEqual(loadClaudeCodeMcpServers(tmp(), tmp()), []);
});

test("loadMcpConfig lets a FreeCode entry shadow a Claude Code entry of the same name", async () => {
  const configDir = tmp();
  const project = tmp();
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      mcp: { servers: [{ name: "dup", type: "local", command: ["mine"] }] },
    }),
  );
  fs.writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { dup: { command: "theirs" }, extra: { command: "e" } } }),
  );
  const prevHome = process.env.HOME;
  process.env.HOME = tmp(); // no ~/.claude.json
  try {
    const config = await loadMcpConfig(configDir, project);
    const dup = config.servers.find((s) => s.name === "dup");
    assert.deepEqual(dup?.command, ["mine"]);
    assert.equal(dup?.source, undefined);
    assert.equal(config.servers.find((s) => s.name === "extra")?.source, "claude-code");
  } finally {
    process.env.HOME = prevHome;
  }
});
