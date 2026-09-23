// =============================================================================
// CheckpointService — capture per user turn, restore on rewind.
//
// Spec `2026-09-23-checkpoints-rewind.md` §4/§5. The only module the loop and
// the server talk to; ShadowGit and CheckpointStore stay private to it.
//
// Every capture path is best-effort: a checkpoint is a convenience, and a
// failure to take one must never fail the turn it was taken for (§4.1).
// Restore is the opposite — it is an explicit user action, so it reports.
// =============================================================================

import { logger } from "../utils/logger.js";
import { loadCheckpointSettings, type CheckpointSettings } from "./settings.js";
import { CheckpointStore, type Checkpoint } from "./store.js";
import { ShadowGit, isGitRepo, type FileChange } from "./shadow-git.js";

export type SkipReason = "disabled" | "not_a_git_repo" | "capture_failed";

export interface CaptureResult {
  snapshot?: string;
  skipped?: SkipReason;
  durationMs: number;
}

export interface RestoreResult {
  restored: FileChange[];
  /** Paths the snapshot could not speak for (see §3.2, oversize untracked). */
  skipped: string[];
  durationMs: number;
}

export class CheckpointService {
  private readonly settings: CheckpointSettings;
  private readonly git: ShadowGit;
  private readonly store: CheckpointStore;
  private repoChecked?: boolean;

  constructor(
    private readonly sessionId: string,
    private readonly projectPath: string,
    settings?: CheckpointSettings,
  ) {
    this.settings = settings ?? loadCheckpointSettings(projectPath);
    this.git = new ShadowGit(projectPath);
    this.store = new CheckpointStore(sessionId, projectPath);
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  private async usable(): Promise<boolean> {
    if (!this.settings.enabled) return false;
    // Cached: `rev-parse` per turn is cheap but not free, and a project does
    // not stop being a repo mid-session.
    this.repoChecked ??= await isGitRepo(this.projectPath);
    return this.repoChecked;
  }

  /**
   * Snapshot the tree as it stands before `entryId`'s turn runs. Returns the
   * reason when nothing was captured, so the caller can record it.
   */
  async capture(entryId: string, preview: string): Promise<CaptureResult> {
    const started = Date.now();
    if (!this.settings.enabled) {
      return { skipped: "disabled", durationMs: 0 };
    }
    if (!(await this.usable())) {
      return { skipped: "not_a_git_repo", durationMs: Date.now() - started };
    }
    const snapshot = await this.git.capture();
    if (!snapshot) {
      return { skipped: "capture_failed", durationMs: Date.now() - started };
    }
    const checkpoint: Checkpoint = {
      entryId,
      snapshot,
      timestamp: Date.now(),
      preview: preview.replace(/\s+/g, " ").trim().slice(0, 120),
    };
    try {
      await this.store.add(checkpoint, this.settings.maxPerSession);
    } catch (err) {
      logger.warn("[Checkpoint] could not persist checkpoint", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { skipped: "capture_failed", durationMs: Date.now() - started };
    }
    return { snapshot, durationMs: Date.now() - started };
  }

  async list(): Promise<Checkpoint[]> {
    return this.store.list();
  }

  /** What `restore(entryId)` would write, without touching disk (§5.1). */
  async preview(entryId: string): Promise<FileChange[]> {
    const checkpoint = await this.store.get(entryId);
    if (!checkpoint) throw new Error(`No checkpoint for message ${entryId}`);
    if (!(await this.usable())) return [];
    return this.git.changesSince(checkpoint.snapshot);
  }

  async restore(entryId: string): Promise<RestoreResult> {
    const started = Date.now();
    const checkpoint = await this.store.get(entryId);
    if (!checkpoint) {
      throw new Error(
        `No checkpoint for message ${entryId} — it predates checkpointing, or was trimmed.`,
      );
    }
    if (!(await this.usable())) {
      throw new Error(
        "Checkpoints are unavailable here (disabled, or the project is not a git repository).",
      );
    }
    const changes = await this.git.changesSince(checkpoint.snapshot);
    const restored = await this.git.restore(checkpoint.snapshot, changes);
    const restoredPaths = new Set(restored.map((c) => c.path));
    return {
      restored,
      skipped: changes
        .filter((c) => !restoredPaths.has(c.path))
        .map((c) => c.path),
      durationMs: Date.now() - started,
    };
  }
}
