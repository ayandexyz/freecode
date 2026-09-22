import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { palette } from "../palette.js";
import type { McpServerStatus } from "../ipc/client.js";
import { SearchableSelectList } from "./searchable-select-list.js";

export function statusLabel(server: McpServerStatus): string {
  if (!server.enabled) return chalk.dim("○ disabled");
  return server.status === "connected"
    ? palette.green(`✔ connected · ${server.toolCount} tools`)
    : palette.yellow("○ not connected");
}

export function createMcpSelector(
  servers: McpServerStatus[],
  callbacks: {
    onSelect: (name: string) => void;
    onCancel: () => void;
  },
  theme: SelectListTheme,
): SearchableSelectList {
  const items: SelectItem[] = servers.map((s) => ({
    label: s.name,
    value: s.name,
    description:
      `${statusLabel(s)}${chalk.dim(` · ${s.type}`)}` +
      (s.source === "claude-code" ? chalk.dim(" · from Claude Code") : ""),
  }));

  const maxVisible = Math.min(items.length, 10);
  const selector = new SearchableSelectList(items, maxVisible, theme);

  selector.onSelect = (item: SelectItem) => callbacks.onSelect(item.value);
  selector.onCancel = () => callbacks.onCancel();

  return selector;
}
