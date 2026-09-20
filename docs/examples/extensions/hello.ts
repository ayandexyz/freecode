// Example FreeCode extension. Copy to ~/.freecode/extensions/hello.ts and run
// /reload (or restart). Spec: docs/specs/2026-09-20-pi-parity-plan.md Phase 5.
import type { ExtensionAPI } from "@thisisayande/freecode-core/extensions";

export default function (api: ExtensionAPI) {
  api.registerTool({
    name: "project_stats",
    description: "Count files by extension in a directory.",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "Directory (default: cwd)" } },
    },
    readOnly: true,
    execute: async (args: { dir?: string }, ctx) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = args.dir ?? ctx.cwd;
      const counts = new Map<string, number>();
      for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f) || "(none)";
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
      return [...counts].map(([e, n]) => `${e}: ${n}`).join("\n");
    },
  });

  api.registerCommand({
    name: "standup",
    description: "Summarize what changed since yesterday",
    prompt: () => "Summarize the git log since yesterday as a standup update.",
  });

  api.on("PostToolUse", async (input) => {
    if (input.toolName === "write") api.log(`wrote ${String(input.toolInput.path)}`);
    return { action: "continue" };
  }, { matcher: "write" });
}
