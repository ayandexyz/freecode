// =============================================================================
// Stream event -> one replayable line of a subagent's activity log.
//
// A subagent's AgentLoop publishes ordinary StreamEvents under its OWN session
// id, which no frontend is subscribed to — so without this they are emitted and
// dropped. The registry folds them into a ring buffer instead, which is what
// the /agents viewer replays on open.
//
// The buffer holds JSON lines of the SNAPSHOT events only: tool calls, their
// results, the turn-end `text` / `thinking` snapshots, and errors. Deltas are
// skipped because the snapshot that follows carries the same characters, and
// `tool_output` because it is a progress tail the result supersedes. A viewer
// that opens mid-run seeds from these and then follows the live deltas itself,
// so it renders a subagent exactly the way the main transcript is rendered.
// =============================================================================

import type { StreamEvent } from "@thisisayande/freecode-shared";

/** Longest tool result kept per event — the ring buffer is shared by all of them. */
const RESULT_CHARS = 8_192;

/**
 * Returns the line to append for this event, or undefined to ignore it.
 * Returned text is appended verbatim and ends in a newline, so a reader can
 * split on "\n" and JSON.parse each line (skipping a partial first line the
 * ring buffer may have cut).
 */
export function formatActivity(event: StreamEvent): string | undefined {
  switch (event.type) {
    case "tool_start":
    case "thinking":
    case "text":
    case "error":
      return `${JSON.stringify(event)}\n`;
    case "tool_complete": {
      const result =
        event.result.length > RESULT_CHARS
          ? `${event.result.slice(0, RESULT_CHARS)}\n… (${event.result.length - RESULT_CHARS} more chars)`
          : event.result;
      return `${JSON.stringify({ ...event, result })}\n`;
    }
    default:
      return undefined;
  }
}
