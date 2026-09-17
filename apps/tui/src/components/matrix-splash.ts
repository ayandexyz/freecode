import type { Component, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { MATRIX_DEFAULTS, MatrixEffect, mulberry32, type Canvas, type Cell } from "./matrix-rain.js";

/** Approximations of chalk.yellowBright / chalk.yellow the resolve fade lands on before the real header swaps in. */
const LOGO_LEFT = "#ffd75f";
const LOGO_RIGHT = "#d7af00";
const TEXT = "#c0c0c0";
const LOGO_ROWS = 3;

const FRAME_MS = 33;
const ANSI = /\[[0-9;]*m/g;

/**
 * Startup splash: matrix rain (`matrix-rain.ts`) over the whole area above
 * the editor, resolving into the logo header, then handing the header
 * slot back to `final`. Sits in the message list's header slot and is exactly
 * as tall as the free space, so the header lands where it would have been
 * drawn anyway and nothing jumps when the effect ends.
 *
 * Runs until it resolves or the user submits a prompt (`finish()`); a width
 * change or a terminal too short for the logo also ends it. Messages that
 * arrive underneath it (startup notices) shrink the canvas, not end it.
 */
export class MatrixSplash implements Component {
  private effect: MatrixEffect | null = null;
  private canvas: Canvas | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private tui: TUI | null = null;
  private stylers = new Map<string, (s: string) => string>();

  constructor(
    private readonly final: Component,
    /** Rows free for the splash plus its trailing blank and the list's: viewport minus what messages take. */
    private readonly getViewportRows: () => number,
    private readonly seed: number = Date.now(),
  ) {}

  setTui(tui: TUI): void {
    this.tui = tui;
  }

  get isRunning(): boolean {
    return !this.finished;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.effect = null;
    this.canvas = null;
    this.tui?.requestRender();
  }

  invalidate(): void {
    (this.final as { invalidate?: () => void }).invalidate?.();
  }

  render(width: number): string[] {
    if (this.finished) return this.final.render(width);

    const target = this.final.render(width).map((l) => l.replace(ANSI, ""));
    const height = this.getViewportRows() - 2;
    if (target.length === 0 || height < target.length + 2) {
      this.finish();
      return this.final.render(width);
    }
    if (!this.effect) this.start(width, height, target);
    else if (this.effect.width !== width) {
      this.finish();
      return this.final.render(width);
    }
    // The header's tool/MCP counts arrive after the splash starts; the effect
    // reads the canvas text each frame, so swapping it in is enough.
    this.canvas!.text = target;
    // A message below the splash takes rows away; the canvas gives them up
    // rather than letting the list clip its top (where the logo resolves).
    // It never grows back — rows freed later just render blank.
    if (height < this.effect!.height) this.effect!.shrink(height);

    return this.effect!.frame().map((row) => this.paintRow(row));
  }

  private start(width: number, height: number, target: string[]): void {
    const canvas: Canvas = {
      width,
      height,
      text: target,
      finalColorAt: (row, col) => {
        const line = canvas.text[row];
        if (line === undefined || col >= line.length) return undefined;
        if (row >= LOGO_ROWS) return TEXT;
        const first = line.search(/\S/);
        const mid = first + Math.floor(line.trim().length / 2);
        return col < mid ? LOGO_LEFT : LOGO_RIGHT;
      },
    };
    this.canvas = canvas;
    this.effect = new MatrixEffect(canvas, { ...MATRIX_DEFAULTS, rng: mulberry32(this.seed) });
    this.timer = setInterval(() => {
      if (!this.effect || !this.effect.tick()) {
        this.finish();
        return;
      }
      this.tui?.requestRender();
    }, FRAME_MS);
  }

  /** Runs of same-coloured cells share one escape sequence; blanks are bare spaces. */
  private paintRow(row: (Cell | null)[]): string {
    let out = "";
    let runColor: string | null = null;
    let run = "";
    const flush = () => {
      if (run === "") return;
      out += runColor === null ? run : this.styler(runColor)(run);
      run = "";
    };
    for (const cell of row) {
      const color = cell?.fg ?? null;
      if (color !== runColor) {
        flush();
        runColor = color;
      }
      run += cell?.sym ?? " ";
    }
    flush();
    return out;
  }

  private styler(hex: string): (s: string) => string {
    let f = this.stylers.get(hex);
    if (!f) {
      f = chalk.hex(hex);
      this.stylers.set(hex, f);
    }
    return f;
  }
}
