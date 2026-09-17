// =============================================================================
// ShellRegistry factory - one registry per ROOT session.
//
// A subagent's shells live in its root's registry: the frontend subscribes to
// the root and `shells.list(root)` is what the panel asks for, so a registry
// keyed by the subagent's synthetic id was invisible to it. Every entrypoint
// resolves through `rootOf`, so callers can keep passing whatever session id
// they hold.
//
// Deliberately NOT an LRU like the OutputStore: evicting a registry would kill
// a dev server the user is still using. Registries are dropped on session end
// (`session/end-session.ts`), which is the only point at which killing the
// session's processes is the right thing to do.
// =============================================================================

import { ShellRegistry } from "./registry.js";
import { getAgentRegistry } from "../../agent/registry/index.js";

export { ShellRegistry } from "./registry.js";
export { SHELL_BUFFER_CHARS, MAX_SHELLS_PER_SESSION } from "./registry.js";
export type { ShellStatus, ShellSummary, ShellReadResult } from "./types.js";

const registries = new Map<string, ShellRegistry>();

/** The session a shell is registered (and its bus events stamped) under. */
export function shellSessionOf(sessionId: string): string {
  return getAgentRegistry().rootOf(sessionId);
}

export function getShellRegistry(sessionId: string): ShellRegistry {
  const rootId = shellSessionOf(sessionId);
  let registry = registries.get(rootId);
  if (!registry) {
    registry = new ShellRegistry();
    registries.set(rootId, registry);
  }
  return registry;
}

/** Read-only peek: never creates a registry, so an IPC poll can't leak one. */
export function peekShellRegistry(
  sessionId: string,
): ShellRegistry | undefined {
  return registries.get(shellSessionOf(sessionId));
}

export function disposeShellRegistry(sessionId: string): void {
  const rootId = shellSessionOf(sessionId);
  registries.get(rootId)?.killAll();
  registries.delete(rootId);
}

/**
 * Subagent teardown: kill only the shells this subagent started. Its shells
 * sit in the ROOT's registry, so disposing that would take the parent's dev
 * server down too.
 */
export function disposeSubagentShells(subagentId: string): void {
  peekShellRegistry(subagentId)?.disposeOwned(subagentId);
}

/** Process teardown — nothing may outlive the daemon. */
export function disposeAllShellRegistries(): void {
  for (const registry of registries.values()) registry.killAll();
  registries.clear();
}
