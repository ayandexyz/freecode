import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import chalk from "chalk";

/** Same yellow the /shells card uses for its border, so the two read as one. */
const SHELLS_CHIP_BG = "#FFD700";
/** Same cyan the /agents card uses, for the same reason. */
const AGENTS_CHIP_BG = "#5FD7FF";

/**
 * ModeLine — the chip row rendered just below the input.
 *
 * Mode, model and effort used to be drawn here; they now sit on the input's
 * bottom border (`PromptEditor.statusLabel`), so this line only carries the
 * /shells and /agents chips and renders nothing while neither is running.
 *
 * Reads all state through getters so a count change only needs a re-render.
 */
export class ModeLine implements Component {
  constructor(
    private getHidden: () => boolean,
    /**
     * Background shells still running. Rendered as a chip so a
     * dev server the agent started stays visible without opening /shells —
     * otherwise a forgotten process is invisible until it holds a port.
     */
    private getRunningShells: () => number = () => 0,
    /**
     * Subagents still running. Rendered as a second chip left of the shells
     * one: delegated work is otherwise invisible until its tool result lands,
     * so a long-running agent looks like a hung turn.
     */
    private getRunningAgents: () => number = () => 0,
  ) {}

  render(width: number): string[] {
    if (this.getHidden()) return [];

    // Only when something is actually running: a permanently-present chip
    // reading (0) is chrome, not information. On a terminal too narrow they
    // drop out rather than pushing the line past `width` and wrapping — the
    // counts are still one keystroke away in /shells and /agents. Budget is
    // spent right-to-left, so the shells chip survives a squeeze that drops
    // the agents one.
    let budget = width - 2;

    const chip = (label: string, bg: string, count: number): string => {
      if (count <= 0 || budget < label.length + 2) return "";
      budget -= label.length + 2;
      return chalk.bgHex(bg)(chalk.bold.black(label)) + "  ";
    };

    const shellsText = chip(
      ` /shells (${this.getRunningShells()}) `,
      SHELLS_CHIP_BG,
      this.getRunningShells(),
    );
    const agentsText = chip(
      ` /agents (${this.getRunningAgents()}) `,
      AGENTS_CHIP_BG,
      this.getRunningAgents(),
    );

    const right = `${agentsText}${shellsText}`;
    if (!right) return [];
    const gap = Math.max(1, width - visibleWidth(right));
    return [`${" ".repeat(gap)}${right}`];
  }

  invalidate(): void {}
}
