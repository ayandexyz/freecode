import type { CommandModule } from "yargs";
import { loadMcpConfig, removeMcpServer } from "../../../mcp/config.js";
import { getConfigDir } from "../../utils/config.js";

interface RemoveArgs {
  name: string;
}

export const removeCommand: CommandModule<object, RemoveArgs> = {
  command: "remove <name>",
  describe: "Remove MCP server",
  builder: (yargs) =>
    yargs.positional("name", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const config = await loadMcpConfig(getConfigDir());
    const server = config.servers.find((s) => s.name === argv.name);
    if (server?.source === "claude-code") {
      console.error(
        `Server "${argv.name}" comes from Claude Code's config; remove it with \`claude mcp remove ${argv.name}\` or set FREECODE_MCP_CLAUDE_CODE=0.`,
      );
      process.exitCode = 1;
      return;
    }
    await removeMcpServer(getConfigDir(), argv.name);
    console.log(`✓ Server "${argv.name}" removed`);
  },
};
