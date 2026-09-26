// =============================================================================
// The session-end memory flush (spec 2026-08-09 D4), as a function both the
// daemon and the eval harness call, so a multi-session eval measures exactly
// what production runs at session end — including how its cost is recorded.
// =============================================================================

import { flushSessionMemory } from "../memory/final-flush.js";
import { subscriptionAuth } from "../providers/config.js";
import { RolloutRecorder } from "../rollout/recorder.js";
import type { SessionStore } from "./store.js";

export interface SessionFlushInput {
  sessionId: string;
  /** The session's own project, never the daemon's cwd. */
  projectPath: string;
  provider: string;
  getStore: () => Promise<Pick<SessionStore, "getMessages">>;
}

/** The `flush` callback `endSession` takes. Resolves to memories saved. */
export function sessionMemoryFlush(input: SessionFlushInput): () => Promise<number> {
  return async () => {
    const store = await input.getStore();
    const messages = await store.getMessages(input.sessionId);
    const recorder = new RolloutRecorder(input.sessionId);
    return flushSessionMemory({
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      provider: input.provider,
      messages,
      onAuxiliaryCall: (call) =>
        recorder.recordMemoryAuxiliary(undefined, {
          purpose: call.purpose,
          provider: call.provider,
          model: call.model,
          duration_ms: call.duration_ms,
          outcome: call.outcome,
          inputTokens: call.usage?.inputTokens,
          outputTokens: call.usage?.outputTokens,
          cacheReadTokens: call.usage?.cacheReadInputTokens,
          cacheWriteTokens:
            call.usage?.cacheWriteInputTokens ??
            call.usage?.cacheCreationInputTokens,
          reasoningTokens: call.usage?.reasoningTokens,
          authMode: subscriptionAuth(call.provider),
        }),
    });
  };
}
