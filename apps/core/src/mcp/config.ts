import * as fs from "fs";
import * as path from "path";
import { McpConfigSchema, type McpConfig, type McpServer } from "./types.js";
import { loadClaudeCodeMcpServers } from "./claude-code-config.js";

const CONFIG_FILE = "config.json";

/** Servers from FreeCode's own config.json only. */
function loadOwnMcpConfig(configDir: string): McpConfig {
  const configPath = path.join(configDir, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    return { servers: [], pollInterval: 5000 };
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(content);

  if (!config.mcp) {
    return { servers: [], pollInterval: 5000 };
  }

  return McpConfigSchema.parse(config.mcp);
}

/**
 * FreeCode's servers plus any Claude Code has configured for `projectPath`
 * (user, project and repo `.mcp.json`). A FreeCode entry wins over a Claude
 * Code entry of the same name, so `freecode mcp add` can override one.
 * `FREECODE_MCP_CLAUDE_CODE=0` turns the import off.
 */
export async function loadMcpConfig(
  configDir: string,
  projectPath: string = process.cwd(),
): Promise<McpConfig> {
  const own = loadOwnMcpConfig(configDir);
  if (process.env.FREECODE_MCP_CLAUDE_CODE === "0") return own;

  const names = new Set(own.servers.map((s) => s.name));
  const imported = loadClaudeCodeMcpServers(projectPath).filter(
    (s) => !names.has(s.name),
  );
  return { ...own, servers: [...own.servers, ...imported] };
}

export async function saveMcpServer(
  configDir: string,
  server: McpServer,
): Promise<void> {
  const configPath = path.join(configDir, CONFIG_FILE);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(content);
  }

  if (!config.mcp) {
    config.mcp = { servers: [], pollInterval: 5000 };
  }

  const mcpConfig = config.mcp as { servers: McpServer[] };
  const existingIndex = mcpConfig.servers.findIndex(
    (s) => s.name === server.name,
  );

  if (existingIndex >= 0) {
    mcpConfig.servers[existingIndex] = server;
  } else {
    mcpConfig.servers.push(server);
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function removeMcpServer(
  configDir: string,
  name: string,
): Promise<void> {
  const configPath = path.join(configDir, CONFIG_FILE);

  if (!fs.existsSync(configPath)) return;

  const content = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(content);

  if (!config.mcp) return;

  const mcpConfig = config.mcp as { servers: McpServer[] };
  mcpConfig.servers = mcpConfig.servers.filter((s) => s.name !== name);

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
