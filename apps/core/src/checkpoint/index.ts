export { CheckpointService } from "./service.js";
export type { CaptureResult, RestoreResult, SkipReason } from "./service.js";
export { CheckpointStore, checkpointsPath } from "./store.js";
export type { Checkpoint } from "./store.js";
export {
  ShadowGit,
  isGitRepo,
  shadowDirFor,
  MAX_UNTRACKED_BYTES,
} from "./shadow-git.js";
export type { FileChange, FileChangeStatus, SnapshotId } from "./shadow-git.js";
export {
  loadCheckpointSettings,
  resolveCheckpointSettings,
  DEFAULT_CHECKPOINT_SETTINGS,
  MAX_CHECKPOINTS_PER_SESSION,
} from "./settings.js";
export type { CheckpointSettings } from "./settings.js";
