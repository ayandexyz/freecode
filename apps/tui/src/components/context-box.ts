import { type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatTokenCount } from "../utils/format-tokens.js";

// formatTokenCount caps a value at 6 columns ("999.9k", "123.4M"), so the widest
// line is "999.9K / 999.9K" — 15 columns.
const MAX_WIDTH = 15;

/**
 * ContextBox — a one-line, top-right overlay showing context-window usage as
 * `tokens / limit` (e.g. `1.5K / 500K`). No border, no label, no bar.
 *
 * Renders nothing when the limit is unknown, so it never fabricates numbers.
 *
 * Renders at a fixed width (`width()`) so callers can pass it to the overlay
 * system and have it anchor correctly to the right edge — without an explicit
 * width, pi-tui defaults the overlay width to 80 cols, which would push the
 * line into the middle of a wide terminal.
 */
export class ContextBox implements Component {
  constructor(
    private getVisible: () => boolean,
    private getContextTokens: () => number,
    private getContextLimit: () => number,
  ) {}

  /** Line width in columns (fixed regardless of terminal width). */
  width(): number {
    return MAX_WIDTH;
  }

  render(width: number): string[] {
    if (!this.getVisible()) return [];
    if (width < MAX_WIDTH) return [];

    const limit = this.getContextLimit();
    if (limit <= 0) return [];

    const tokens = this.getContextTokens();
    const fmt = (n: number) => formatTokenCount(n).toUpperCase();
    const usage = `${fmt(tokens)} / ${fmt(limit)}`;

    // Right-align so the line stays flush against the edge it's anchored to.
    const leftPad = " ".repeat(Math.max(0, width - usage.length));
    return [leftPad + chalk.dim(usage)];
  }

  invalidate(): void {}
}
