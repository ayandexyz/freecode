// =============================================================================
// Extension API (spec 2026-09-20-pi-parity-plan, Phase 5; pi's ExtensionAPI).
//
// An extension is a module in `~/.freecode/extensions/` or
// `<project>/.freecode/extensions/` whose default export is
// `(api: ExtensionAPI) => void | Promise<void>`. It can add tools, prompt
// commands and lifecycle hooks without touching core. Everything it registers
// is tracked so `/reload` can take it back out.
//
// What this is NOT (yet): UI (the TUI is a thin client with no IPC surface for
// extension widgets), providers, or a sandbox — an extension runs in-process
// with the user's permissions, exactly like pi's.
// =============================================================================

import type { JsonSchema } from "../tools/tool.types.js";
import type { ToolContext } from "../tools/types.js";
import type { HookEventName, ToolCallInput, HookContext, HookResult } from "../hooks/types.js";

export interface ExtensionToolDef<P = Record<string, unknown>> {
  /** Tool id as the model sees it. Must not collide with a built-in. */
  name: string;
  description: string;
  /** JSON schema for the arguments — give every property a `type`. */
  parameters: JsonSchema;
  /**
   * Declare read-only to be offered in plan/review/explore modes. Unknown
   * tools are mutating (fail closed), same as an unannotated MCP tool.
   */
  readOnly?: boolean;
  execute: (
    args: P,
    ctx: ToolContext,
  ) => Promise<string | { output: string; title?: string }>;
}

export interface ExtensionCommandDef {
  /** Invoked as `/name`. */
  name: string;
  description: string;
  argHint?: string;
  /** The prompt sent to the agent. */
  prompt: (ctx: { cwd: string; args: string[] }) => string;
}

export interface ExtensionAPI {
  /** The extension's file, for logs. */
  readonly source: string;
  /** "user" (~/.freecode) or "project" (<project>/.freecode). */
  readonly scope: "user" | "project";
  registerTool<P = Record<string, unknown>>(def: ExtensionToolDef<P>): void;
  registerCommand(def: ExtensionCommandDef): void;
  /**
   * A lifecycle hook. Runs in-process; for tool events `input` carries the
   * tool name, arguments and (PostToolUse) result. `matcher` narrows tool
   * events to one tool name.
   */
  on(
    event: HookEventName,
    handler: (input: ToolCallInput, context: HookContext) => Promise<HookResult> | HookResult,
    options?: { matcher?: string },
  ): void;
  log(message: string): void;
}

export type ExtensionModule = (api: ExtensionAPI) => void | Promise<void>;

export interface LoadedExtension {
  source: string;
  scope: "user" | "project";
  tools: string[];
  commands: string[];
  hooks: Array<{ event: HookEventName; name: string }>;
  error?: string;
}
