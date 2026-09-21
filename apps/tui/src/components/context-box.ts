import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CacheStats, CacheMissSample } from "@thisisayande/freecode-shared";
import chalk from "chalk";
import { palette } from "../palette.js";
import { formatTokenCount } from "../utils/format-tokens.js";

// Sized to the widest miss row with the longest built-in reason,
// "12.3> 999.9k miss (harness: prefix rewritten)" — 45 columns; a documented
// reason (journal source + detail) is truncated to fit. The summary line
// "yield 100% · last 100% · session 100%" is 37.
const MAX_WIDTH = 46;

/** Most recent misses shown before folding the rest into "… N more". */
const MAX_MISS_ROWS = 5;

/**
 * ContextBox — a top-right overlay showing context-window usage as
 * `tokens / limit` (e.g. `1.5K / 500K`), then the session's prompt-cache
 * accounting in jcode's KV-cache-widget shape:
 *
 *   yield 99% · last 97% · session 91%
 *   miss attribution
 *   3.2> 40.1k miss (model switch)
 *
 * `yield` is the harness-health number (read ÷ what the previous request made
 * cacheable), `last`/`session` the cost numbers (read ÷ prompt). Every ratio
 * comes from core (`cache_status.stats`); this only draws. Before core has
 * reported stats, the last run's plain hit rate (`cache 87%`) stands in.
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
    private getCacheRate: () => number | undefined = () => undefined,
    private getCacheStats: () => CacheStats | undefined = () => undefined,
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
    const lines = [chalk.dim(`${fmt(tokens)} / ${fmt(limit)}`)];

    const stats = this.getCacheStats();
    if (stats) {
      lines.push(renderCacheSummary(stats), ...renderMissAttribution(stats));
    } else {
      const rate = this.getCacheRate();
      if (rate !== undefined) lines.push(chalk.dim(`cache ${rate}%`));
    }

    // Right-align so the lines stay flush against the edge they're anchored to.
    return lines.map(
      (line) => " ".repeat(Math.max(0, width - visibleWidth(line))) + line,
    );
  }

  invalidate(): void {}
}

/** jcode's thresholds: red < 25, yellow < 60, blue < 85, green otherwise. */
function healthPaint(pct: number) {
  if (pct < 25) return palette.red;
  if (pct < 60) return palette.yellow;
  if (pct < 85) return palette.blue;
  return palette.green;
}

function renderCacheSummary(stats: CacheStats): string {
  // Colour follows the freshest health signal available, as in jcode.
  const health =
    stats.lastYieldPct ?? stats.lastPct ?? stats.yieldPct ?? stats.sessionPct;
  const paint = healthPaint(health);
  const label = (s: string) => chalk.dim(s);
  const value = (n: number) => chalk.bold(paint(`${n}%`));
  const parts: string[] = [];
  parts.push(
    stats.yieldPct === undefined
      ? chalk.bold(paint("priming"))
      : `${label("yield ")}${value(stats.yieldPct)}`,
  );
  if (stats.lastPct !== undefined) {
    parts.push(`${label("last ")}${value(stats.lastPct)}`);
  }
  parts.push(`${label("session ")}${value(stats.sessionPct)}`);
  return parts.join(chalk.dim(" · "));
}

function renderMissAttribution(stats: CacheStats): string[] {
  const lines = [chalk.dim.bold("miss attribution")];
  if (stats.misses.length === 0) {
    lines.push(palette.green("none"));
    return lines;
  }
  const total = stats.misses.reduce((sum, m) => sum + m.missedTokens, 0);
  lines.push(chalk.dim(`${formatTokenCount(total)} missed total`));
  const recent = stats.misses.slice(-MAX_MISS_ROWS);
  for (const miss of recent) lines.push(renderMissRow(miss));
  const hidden = stats.misses.length - recent.length;
  if (hidden > 0) lines.push(chalk.dim(`… ${hidden} more`));
  return lines;
}

function renderMissRow(miss: CacheMissSample): string {
  const turn = miss.turn
    ? miss.turn.call <= 1
      ? `${miss.turn.run}>`
      : `${miss.turn.run}.${miss.turn.call}>`
    : "?>";
  const head = `${chalk.bold(palette.blue(turn))} ${palette.yellow(
    `${formatTokenCount(miss.missedTokens)} miss`,
  )} `;
  // A harness bug is the one row worth a second look, so it keeps its colour;
  // legitimate causes stay dim.
  const reasonPaint = miss.harnessBug ? palette.red : chalk.dim;
  const room = MAX_WIDTH - visibleWidth(head) - 2; // the parentheses
  const reason =
    miss.reason.length > room
      ? `${miss.reason.slice(0, Math.max(0, room - 1))}…`
      : miss.reason;
  return `${head}${reasonPaint(`(${reason})`)}`;
}
