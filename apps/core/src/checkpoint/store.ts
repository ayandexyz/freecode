// =============================================================================
// Checkpoint sidecar — which snapshot belongs to which user message.
//
// Spec `2026-09-23-checkpoints-rewind.md` §4.1/§6. Lives beside the session's
// messages.jsonl as checkpoints.json rather than inside it: a checkpoint is
// derived state about the working tree, not a conversation entry, and putting
// it in the log would put tree ids into every reader that walks messages.
// =============================================================================

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { formatSessionDirName } from "../store/path-formatter.js";
import type { SnapshotId } from "./shadow-git.js";

const FILE = "checkpoints.json";

export interface Checkpoint {
  /** The session-store entry id of the user message this precedes. */
  entryId: string;
  snapshot: SnapshotId;
  timestamp: number;
  /** First line of the prompt, for the picker. Trimmed to 120 chars. */
  preview: string;
}

interface Sidecar {
  version: 1;
  checkpoints: Checkpoint[];
}

function baseDir(): string {
  return process.env.FREECODE_HOME ?? join(homedir(), ".freecode");
}

export function checkpointsPath(
  sessionId: string,
  projectPath: string,
): string {
  return join(
    baseDir(),
    "sessions",
    formatSessionDirName(projectPath),
    sessionId,
    FILE,
  );
}

export class CheckpointStore {
  constructor(
    private readonly sessionId: string,
    private readonly projectPath: string,
  ) {}

  private get path(): string {
    return checkpointsPath(this.sessionId, this.projectPath);
  }

  async list(): Promise<Checkpoint[]> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Sidecar;
      return Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
    } catch {
      return [];
    }
  }

  async get(entryId: string): Promise<Checkpoint | undefined> {
    return (await this.list()).find((c) => c.entryId === entryId);
  }

  /** Append, trimming to the most recent `maxPerSession` (§6). */
  async add(checkpoint: Checkpoint, maxPerSession: number): Promise<void> {
    const existing = (await this.list()).filter(
      (c) => c.entryId !== checkpoint.entryId,
    );
    existing.push(checkpoint);
    const trimmed = existing.slice(-Math.max(1, maxPerSession));
    const sidecar: Sidecar = { version: 1, checkpoints: trimmed };
    await mkdir(dirname(this.path), { recursive: true });
    // Atomic: a half-written sidecar would read as "no checkpoints", which
    // silently disables undo rather than announcing a problem.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(sidecar, null, 2), "utf-8");
    await rename(tmp, this.path);
  }
}
