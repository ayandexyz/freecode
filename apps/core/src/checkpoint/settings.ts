// =============================================================================
// Checkpoint settings — project → user → default, the same scope order as
// `agent/signals/settings.ts` and `redirect/settings.ts`.
//
//   ~/.freecode/settings.json  or  <project>/.freecode/settings.json
//   { "checkpoints": { "enabled": true, "maxPerSession": 100 } }
//
// Env: FREECODE_CHECKPOINTS — "1" on, "0" off, beating the files.
//
// Unlike the three loop gates this defaults ON (spec §8): it does not change
// what the model does, it only records tree state the user may later ask for,
// so the "flip a default only on an eval ab delta" rule does not apply.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envFlag } from "../agent/signals/settings.js";

/** claude-code's MAX_SNAPSHOTS. */
export const MAX_CHECKPOINTS_PER_SESSION = 100;

export interface CheckpointSettings {
  enabled: boolean;
  maxPerSession: number;
}

export const DEFAULT_CHECKPOINT_SETTINGS: CheckpointSettings = {
  enabled: true,
  maxPerSession: MAX_CHECKPOINTS_PER_SESSION,
};

type Scope = Partial<CheckpointSettings>;

function readScope(filePath: string): Scope | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      checkpoints?: Scope;
    };
    return parsed.checkpoints;
  } catch {
    return undefined;
  }
}

export function resolveCheckpointSettings(
  scopes: Scope[],
  env: NodeJS.ProcessEnv = process.env,
): CheckpointSettings {
  const enabled = scopes.find((s) => typeof s.enabled === "boolean")?.enabled;
  const max = scopes.find(
    (s) =>
      typeof s.maxPerSession === "number" &&
      Number.isFinite(s.maxPerSession) &&
      s.maxPerSession > 0,
  )?.maxPerSession;
  return {
    enabled:
      envFlag(env.FREECODE_CHECKPOINTS) ??
      enabled ??
      DEFAULT_CHECKPOINT_SETTINGS.enabled,
    maxPerSession: max
      ? Math.floor(max)
      : DEFAULT_CHECKPOINT_SETTINGS.maxPerSession,
  };
}

export function loadCheckpointSettings(
  projectRoot: string,
): CheckpointSettings {
  const scopes = [
    path.join(projectRoot, ".freecode", "settings.json"),
    path.join(os.homedir(), ".freecode", "settings.json"),
  ]
    .map(readScope)
    .filter((s): s is Scope => s !== undefined);
  return resolveCheckpointSettings(scopes);
}
