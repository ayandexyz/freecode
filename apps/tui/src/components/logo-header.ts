import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { logoLines } from "../assets/logo.js";
import { getDisplayDirectory, getVersion } from "../utils/display.js";
import { palette } from "../palette.js";

// Two-tone logo: accent for the bright half, accentDim for the other — the
// active theme on Omarchy, the chalk yellows elsewhere.
const { accent: accentColor, accentDim: dimColor } = palette;

// Split on the blank column between the A and C glyphs (col 39 of 85) so
// the seam is OMA | CODE. floor(len/2) = 42 cut through the middle of the C,
// leaving that one letter two-toned.
const COLOR_SPLIT = 39;

const coloredLogoLines = logoLines.map((line) => {
  return accentColor(line.slice(0, COLOR_SPLIT)) + dimColor(line.slice(COLOR_SPLIT));
});

const LOGO_WIDTH = 85;

/** Blank rows rendered above the logo. */
const TOP_PADDING = 4;

/** "-1" sentinel from the index.ts cache means "not loaded yet". */
const PENDING = "…";

/**
 * Pinned top-of-TUI logo header. Renders the OmaCode logo (centered, two-tone
 * yellow) with the `>_ OmaCode (vX.Y.Z)` subtitle, a compact stats line
 * (tools/MCP/skills/plugins counts) and a directory line — all centered and in yellow.
 *
 * The counts come from accessor functions so the parent can cache them
 * once at startup and the header stays synchronous.
 */
export class LogoHeader implements Component {
  /**
   * Rendered every frame as the message list's first entry (even in follow
   * mode, where the window slice usually discards it), so the lines are
   * cached on everything they actually depend on: width and the counts
   * (version and cwd are fixed for the process).
   */
  private cache?: {
    width: number;
    tools: number;
    mcp: number;
    skills: number;
    plugins: number;
    lines: string[];
  };

  constructor(
    private getToolCount: () => number,
    private getMcpCount: () => number,
    private getSkillCount: () => number,
    private getPluginCount: () => number,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Center a styled fragment by padding with spaces. `visiblePlainLen` is the
   * width of the *plain* (ANSI-stripped) text — needed because chalk adds
   * escape codes that mis-align a naive `.length` measurement.
   */
  private centerLine(width: number, visiblePlainLen: number, styled: string): string {
    const padLeft = Math.max(0, Math.floor((width - visiblePlainLen) / 2));
    const padRight = Math.max(0, width - visiblePlainLen - padLeft);
    return " ".repeat(padLeft) + styled + " ".repeat(padRight);
  }

  private formatCount(n: number): string {
    return n < 0 ? PENDING : String(n);
  }

  render(width: number): string[] {
    if (width < LOGO_WIDTH) {
      // Logo is 34 chars wide; skip the overlay rather than truncating it.
      return [];
    }

    const toolCount = this.getToolCount();
    const mcpCount = this.getMcpCount();
    const skillCount = this.getSkillCount();
    const pluginCount = this.getPluginCount();
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.tools === toolCount &&
      this.cache.mcp === mcpCount &&
      this.cache.skills === skillCount &&
      this.cache.plugins === pluginCount
    ) {
      return this.cache.lines;
    }

    const padLeft = Math.max(0, Math.floor((width - LOGO_WIDTH) / 2));
    const padRight = Math.max(0, width - LOGO_WIDTH - padLeft);
    const indent = " ".repeat(padLeft);
    const rightPad = " ".repeat(padRight);

    // Subtitle: `>_ OmaCode (vX.Y.Z)` — plain + styled built separately so the
    // centered pad math matches the visible width.
    const version = getVersion();
    const subtitlePlain = `>_ OmaCode (v${version})`;
    const subtitleStyled =
      `>_ ${chalk.bold(palette.accent("OmaCode"))} ` +
      chalk.dim(`(v${version})`);
    const subtitleLine = this.centerLine(width, subtitlePlain.length, subtitleStyled);

    // Stats: `Tools: N    MCP: M    Skills: K    Plugins: P` — dimmed
    // labels, plain values, four spaces between pairs.
    const stats: Array<[string, number]> = [
      ["Tools", toolCount],
      ["MCP", mcpCount],
      ["Skills", skillCount],
      ["Plugins", pluginCount],
    ];
    const statsPlain = stats
      .map(([label, n]) => `${label}: ${this.formatCount(n)}`)
      .join("    ");
    const statsStyled = stats
      .map(([label, n]) => chalk.dim(`${label}:`) + ` ${this.formatCount(n)}`)
      .join("    ");
    const statsLine = this.centerLine(width, statsPlain.length, statsStyled);

    // Directory: `Directory: <cwd>` — dimmed label, plain path.
    const cwd = getDisplayDirectory();
    const dirPlain = `Directory: ${cwd}`;
    const dirStyled = chalk.dim("Directory:") + ` ${cwd}`;
    const dirLine = this.centerLine(width, dirPlain.length, dirStyled);

    // Breathing room above the logo so it does not sit flush against the
    // status bar.
    const topPad = Array.from({ length: TOP_PADDING }, () => "");

    const lines = [
      ...topPad,
      ...coloredLogoLines.map((logoLine) => `${indent}${logoLine}${rightPad}`),
      "", // gap between the logo and its subtitle
      subtitleLine,
      statsLine,
      dirLine,
    ].map((line) => truncateToWidth(line, width));
    this.cache = {
      width,
      tools: toolCount,
      mcp: mcpCount,
      skills: skillCount,
      plugins: pluginCount,
      lines,
    };
    return lines;
  }
}
