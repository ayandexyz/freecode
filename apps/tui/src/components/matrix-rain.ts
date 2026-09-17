/**
 * Matrix digital-rain effect, ported from ttfx's `effects/matrix.rs` (itself a
 * parity port of TerminalTextEffects' `effect_matrix.py`). Pure state machine:
 * `tick()` advances one frame, `frame()` paints it. No timers, no terminal —
 * the wrapper component (`matrix-splash.ts`) owns both.
 *
 * Three phases, as upstream: RAIN (columns of random glyphs fall, trail, drop
 * off the bottom) for `rainTicks` frames → FILL (every column fills top to
 * bottom and holds) → RESOLVE (cells dissolve at random; the ones that hold a
 * target character fade highlight → final colour, the rest go dark).
 *
 * Deviations from upstream, all so a fullscreen splash finishes in ~3s rather
 * than the 15s+ a CLI toy can afford: the rain deadline is a frame count, not
 * wall-clock; rain bursts scale with width; FILL reveals `ceil(height/15)`
 * rows per frame; columns still raining at the deadline are rushed off the
 * bottom at that same step; RESOLVE dissolves a batch sized to the canvas
 * height. Colours are hex strings — the painter decides what to do with them.
 */

// ---- contracts -------------------------------------------------------------

/** One painted cell; `fg` is `#rrggbb`. */
export interface Cell {
  sym: string;
  fg: string;
}

/** `height` rows of `width` cells; `null` is an empty cell. */
export type Frame = (Cell | null)[][];

/** The text the effect resolves into. */
export interface Canvas {
  width: number;
  height: number;
  /** One string per row from row 0, each padded to `width`; mutable so a host can refresh it. */
  text: string[];
  /** Final colour of (row, col); `undefined` = not part of the text. */
  finalColorAt?: (row: number, col: number) => string | undefined;
}

export type Rng = () => number;

// ---- options ---------------------------------------------------------------

/** Upstream's default `--rain-symbols`: digits, punctuation and halfwidth katakana, all one cell wide. */
export const RAIN_SYMBOLS: readonly string[] = [
  "2", "5", "9", "8", "Z", "*", ")", ":", ".", "\"", "=", "+", "-", "¦", "|", "_",
  "ｦ", "ｱ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｹ", "ｺ", "ｻ", "ｼ", "ｽ", "ｾ", "ｿ", "ﾀ", "ﾂ",
  "ﾃ", "ﾅ", "ﾆ", "ﾇ", "ﾈ", "ﾊ", "ﾋ", "ﾎ", "ﾏ", "ﾐ", "ﾑ", "ﾒ", "ﾓ", "ﾔ", "ﾕ", "ﾗ",
  "ﾘ", "ﾜ",
];

export interface MatrixOptions {
  /** Frames spent raining before the fill phase starts. Upstream: 15 s of wall-clock. */
  rainTicks: number;
  /** Bright head of a falling column. */
  highlightColor: string;
  /** Stops of the trail gradient; expanded to six colours. */
  rainColorGradient: string[];
  rainSymbols: readonly string[];
  /** Frames between rows, drawn per column from this inclusive range. */
  rainFallDelayRange: [number, number];
  /** Frames between bursts of new columns. */
  rainColumnDelayRange: [number, number];
  symbolSwapChance: number;
  colorSwapChance: number;
  /** Frames between resolve rounds. */
  resolveDelay: number;
  /** Stops of the fallback final-colour gradient (top → bottom) when the canvas gives none. */
  finalGradientStops: string[];
  /** Steps in the highlight → final fade of a resolved cell. */
  finalGradientSteps: number;
  /** Frames each fade step is held. */
  finalGradientFrames: number;
}

/**
 * Tuned for a ~30 fps splash that finishes in a few seconds. Upstream's CLI
 * defaults (15 s rain, 2–15 frame fall delay at 60 fps) are in the comments.
 */
export const MATRIX_DEFAULTS: MatrixOptions = {
  rainTicks: 45, // upstream: --rain-time 15 (seconds)
  highlightColor: "#dbffdb",
  rainColorGradient: ["#92be92", "#185318"],
  rainSymbols: RAIN_SYMBOLS,
  rainFallDelayRange: [1, 5], // upstream: 2-15; fill delay is ⌊hi/3⌋, so 1
  rainColumnDelayRange: [1, 4], // upstream: 3-9
  symbolSwapChance: 0.005,
  colorSwapChance: 0.001,
  resolveDelay: 1, // upstream: 3
  finalGradientStops: ["#92be92", "#336b33"],
  finalGradientSteps: 8,
  finalGradientFrames: 2, // upstream: 3
};

// ---- column ----------------------------------------------------------------

/** A glyph in a column: where it belongs and where it is currently drawn. */
export interface Drop {
  /** Row this glyph resolves at. */
  home: number;
  /** Row it is drawn at — differs from `home` only after a column drop. */
  row: number;
  sym: string;
  color: string;
}

export type ColumnPhase = "rain" | "fill";

/** RainColumn from upstream: one column's pending / visible glyphs and its pacing. */
export class RainColumn {
  pending: number[] = [];
  visible: Drop[] = [];
  phase: ColumnPhase = "rain";
  dropChance = 0.08;
  holdTime = 0;
  /** Rows a drop slides the trail by; >1 only once the deadline rushes the column off. */
  private dropStep = 1;
  private baseDelay = 0;
  private activeDelay = 0;
  private length = 0;

  constructor(
    readonly col: number,
    private height: number,
    private readonly opts: MatrixOptions & { rng: () => number; rainColors: string[] },
  ) {
    this.setup("rain");
  }

  /** RainColumn.setup_column — reset for a fresh pass in `phase`. */
  setup(phase: ColumnPhase): void {
    const { rng } = this.opts;
    this.phase = phase;
    this.pending = Array.from({ length: this.height }, (_, r) => r);
    this.visible = [];
    const [lo, hi] = this.opts.rainFallDelayRange;
    this.baseDelay =
      phase === "fill"
        ? randint(rng, Math.max(Math.floor(lo / 3), 1), Math.max(Math.floor(hi / 3), 1))
        : randint(rng, lo, hi);
    this.activeDelay = 0;
    this.length =
      phase === "rain"
        ? randint(rng, Math.max(1, Math.floor(this.height * 0.1)), this.height)
        : this.height;
    this.holdTime = this.length === this.height ? randint(rng, 20, 45) : 0;
    this.dropStep = 1;
  }

  /**
   * The rain deadline hit: fall off the canvas as fast as the fill phase
   * climbs, so the switch reads as one motion. Upstream sets dropChance=1 and
   * lets the column's own delay pace it.
   */
  rush(step: number): void {
    this.holdTime = 0;
    this.dropChance = 1;
    this.dropStep = step;
    this.baseDelay = 0;
    this.activeDelay = 0;
  }

  /** Canvas lost rows at the bottom: forget everything that lived there. */
  shrink(height: number): void {
    this.height = height;
    this.pending = this.pending.filter((r) => r < height);
    this.visible = this.visible.filter((d) => d.row < height && d.home < height);
    this.length = Math.min(this.length, height);
  }

  get full(): boolean {
    return this.pending.length === 0;
  }

  /** RainColumn.tick — one frame; up to `reveal` rows light up if the delay is due. */
  tick(reveal: number): void {
    const { rng, rainColors, highlightColor } = this.opts;
    if (this.activeDelay === 0) {
      if (this.pending.length > 0) {
        for (let i = 0; i < reveal && this.pending.length > 0; i++) this.revealNext();
      } else if (this.visible.length > 0) {
        // Column is complete: drop the head highlight, then hold, then decay.
        const last = this.visible[this.visible.length - 1]!;
        if (last.color === highlightColor) last.color = choice(rng, rainColors);
        if (this.holdTime !== 0) {
          this.holdTime -= 1;
        } else if (this.phase === "rain") {
          if (rng() < this.dropChance) this.drop();
          this.trim();
        }
      }
      if (this.visible.length > this.length) this.trim();
      this.activeDelay = this.baseDelay;
    } else {
      this.activeDelay -= 1;
    }

    for (const d of this.visible) {
      if (rng() < this.opts.symbolSwapChance) d.sym = choice(rng, this.opts.rainSymbols);
      if (rng() < this.opts.colorSwapChance) d.color = choice(rng, rainColors);
    }
  }

  /** RainColumn.resolve_char — pull one random glyph out of the column. */
  resolveOne(): Drop {
    const i = randint(this.opts.rng, 0, this.visible.length - 1);
    return this.visible.splice(i, 1)[0]!;
  }

  private revealNext(): void {
    const { rng, rainColors, highlightColor } = this.opts;
    const home = this.pending.shift()!;
    const prev = this.visible[this.visible.length - 1];
    if (prev) prev.color = choice(rng, rainColors);
    this.visible.push({ home, row: home, sym: choice(rng, this.opts.rainSymbols), color: highlightColor });
  }

  /** RainColumn.trim_column — the oldest glyph goes dark, the next fades. */
  private trim(): void {
    if (this.visible.length === 0) return;
    this.visible.shift();
    if (this.visible.length > 1) {
      const tail = this.opts.rainColors.slice(-3);
      this.visible[0]!.color = adjustBrightness(choice(this.opts.rng, tail), 0.65);
    }
  }

  /** RainColumn.drop_column — the whole trail slides down. */
  private drop(): void {
    for (const d of this.visible) d.row += this.dropStep;
    this.visible = this.visible.filter((d) => d.row < this.height);
  }
}

// ---- effect ----------------------------------------------------------------



interface Resolving {
  row: number;
  col: number;
  sym: string;
  spectrum: string[];
  step: number;
  framesLeft: number;
}

export class MatrixEffect {
  readonly width: number;
  height: number;
  private readonly columns: RainColumn[];
  private pendingCols: number[];
  private activeCols: number[] = [];
  private fullCols: number[] = [];
  private resolving: Resolving[] = [];
  private phase: "rain" | "fill" | "resolve" = "rain";
  private columnDelay = 0;
  private resolveDelay: number;
  private ticks = 0;
  private rainComplete = false;
  private finalFrameShown = false;
  private readonly fillRowsPerTick: number;
  private readonly rainColors: string[];
  private readonly finalFallback: string[];

  constructor(
    private readonly canvas: Canvas,
    private readonly opts: MatrixOptions & { rng: Rng },
  ) {
    this.width = canvas.width;
    this.height = canvas.height;
    this.resolveDelay = opts.resolveDelay;
    this.rainColors = gradient(opts.rainColorGradient, 6);
    this.finalFallback = gradient(opts.finalGradientStops, Math.max(1, canvas.text.length));
    const columnOpts = { ...opts, rainColors: this.rainColors };
    this.columns = Array.from({ length: this.width }, (_, c) => new RainColumn(c, this.height, columnOpts));
    this.pendingCols = shuffle(opts.rng, this.columns.map((_, i) => i));
    this.fillRowsPerTick = Math.max(1, Math.ceil(this.height / 15));
  }

  get done(): boolean {
    return this.finalFrameShown;
  }

  tick(): boolean {
    if (this.finalFrameShown) return false;
    this.ticks += 1;
    if (this.phase !== "resolve") this.tickRainOrFill();
    else this.tickResolve();
    this.tickResolving();

    const busy =
      this.fullCols.length > 0 ||
      this.activeCols.length > 0 ||
      this.resolving.length > 0 ||
      this.pendingCols.length > 0 ||
      !this.rainComplete;
    if (!busy) this.finalFrameShown = true;
    return true;
  }

  shrink(height: number): void {
    if (height >= this.height) return;
    this.height = height;
    for (const column of this.columns) column.shrink(height);
    this.resolving = this.resolving.filter((r) => r.row < height);
    this.activeCols = this.activeCols.filter((ci) => this.columns[ci]!.visible.length > 0);
    this.fullCols = this.fullCols.filter((ci) => this.columns[ci]!.visible.length > 0);
  }

  frame(): Frame {
    const grid = emptyFrame(this.width, this.height);
    // Settled text underneath, live rain and fading cells over it.
    if (this.phase === "resolve") {
      for (let r = 0; r < this.canvas.text.length && r < this.height; r++) {
        for (let c = 0; c < this.width; c++) {
          const sym = charAt(this.canvas, r, c);
          if (sym === " ") continue;
          const fg = this.finalColorAt(r, c);
          if (fg !== undefined && this.settled(r, c)) grid[r]![c] = { sym, fg };
        }
      }
    }
    for (const r of this.resolving) grid[r.row]![r.col] = { sym: r.sym, fg: r.spectrum[r.step]! };
    for (const column of this.columns) {
      for (const d of column.visible) grid[d.row]![column.col] = { sym: d.sym, fg: d.color };
    }
    return grid;
  }

  private finalColorAt(row: number, col: number): string | undefined {
    if (this.canvas.finalColorAt) return this.canvas.finalColorAt(row, col);
    return row < this.canvas.text.length ? this.finalFallback[row] : undefined;
  }

  private tickRainOrFill(): void {
    const { rng } = this.opts;
    if (this.columnDelay === 0) {
      // Upstream starts 1–3 columns per burst and has 15 s to cover the canvas;
      // scale the burst with width so ~1 s of rain still gets everywhere.
      const n = this.phase === "rain" ? randint(rng, 1, 3) * Math.ceil(this.width / 40) : this.pendingCols.length;
      for (let i = 0; i < n && this.pendingCols.length > 0; i++) this.activeCols.push(this.pendingCols.shift()!);
      this.columnDelay = this.phase === "rain" ? randint(rng, ...this.opts.rainColumnDelayRange) : 1;
    } else {
      this.columnDelay -= 1;
    }

    const reveal = this.phase === "fill" ? this.fillRowsPerTick : 1;
    for (const ci of [...this.activeCols]) {
      const column = this.columns[ci]!;
      column.tick(reveal);
      if (column.full) {
        if (column.phase === "fill" && !this.fullCols.includes(ci)) {
          this.fullCols.push(ci);
        } else if (column.visible.length === 0) {
          column.setup(this.phase === "fill" ? "fill" : "rain");
          this.pendingCols.push(ci);
        }
      }
    }
    this.activeCols = this.activeCols.filter((ci) => this.columns[ci]!.visible.length > 0);

    if (
      this.phase === "fill" &&
      this.pendingCols.length === 0 &&
      this.activeCols.every((ci) => this.columns[ci]!.full && this.columns[ci]!.phase === "fill")
    ) {
      this.phase = "resolve";
      this.activeCols = [];
    }

    if (this.phase === "rain" && this.ticks > this.opts.rainTicks) {
      this.rainComplete = true;
      this.phase = "fill";
      for (const ci of this.activeCols) this.columns[ci]!.rush(this.fillRowsPerTick);
      for (const ci of this.pendingCols) this.columns[ci]!.setup("fill");
    }
  }

  private tickResolve(): void {
    const { rng } = this.opts;
    const batchMax = Math.max(4, Math.ceil(this.height / 6));
    for (const ci of [...this.fullCols]) {
      const column = this.columns[ci]!;
      column.tick(1);
      if (column.visible.length === 0 || this.resolveDelay !== 0) continue;
      const n = randint(rng, 1, batchMax);
      for (let i = 0; i < n && column.visible.length > 0; i++) {
        const drop = column.resolveOne();
        const fg = this.finalColorAt(drop.home, ci);
        const sym = charAt(this.canvas, drop.home, ci);
        if (fg === undefined || sym === " ") continue;
        this.resolving.push({
          row: drop.home,
          col: ci,
          sym,
          spectrum: gradient([this.opts.highlightColor, fg], this.opts.finalGradientSteps),
          step: 0,
          framesLeft: this.opts.finalGradientFrames,
        });
      }
    }
    this.resolveDelay = this.resolveDelay === 0 ? this.opts.resolveDelay : this.resolveDelay - 1;
    this.fullCols = this.fullCols.filter((ci) => this.columns[ci]!.visible.length > 0);
  }

  /** Advance every fading cell; one on its last step is settled and leaves the list. */
  private tickResolving(): void {
    this.resolving = this.resolving.filter((r) => {
      r.framesLeft -= 1;
      if (r.framesLeft > 0) return true;
      r.framesLeft = this.opts.finalGradientFrames;
      r.step += 1;
      return r.step < r.spectrum.length - 1;
    });
  }

  /** A target cell shows its final glyph once its column released it and it is not mid-fade. */
  private settled(row: number, col: number): boolean {
    const column = this.columns[col]!;
    if (column.visible.some((d) => d.home === row)) return false;
    return !this.resolving.some((r) => r.row === row && r.col === col);
  }
}

// ---- helpers ---------------------------------------------------------------

/** A blank `height × width` frame. */
function emptyFrame(width: number, height: number): Frame {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => null));
}

/** Character of the canvas text at (row, col); a space outside the text. */
function charAt(canvas: Canvas, row: number, col: number): string {
  return canvas.text[row]?.[col] ?? " ";
}

/** Plain-text view of a frame, for tests. */
export function frameToLines(frame: Frame): string[] {
  return frame.map((row) => row.map((c) => c?.sym ?? " ").join(""));
}

/** Deterministic 32-bit PRNG (mulberry32): same seed, same frames. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Python-style inclusive `randint`. */
export function randint(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function choice<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/** In-place Fisher–Yates; returns the same array. */
export function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}


export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`invalid colour: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Animation.adjust_color_brightness — scale every channel. */
export function adjustBrightness(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * factor, g * factor, b * factor]);
}

/** Linear blend of two colours, `t` in `[0, 1]`. */
export function mix(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/**
 * Gradient.with_steps: `steps` colours from `stops[0]` to the last stop,
 * both ends included, evenly spread across the stops.
 */
export function gradient(stops: readonly string[], steps: number): string[] {
  if (stops.length === 0) throw new Error("gradient needs at least one stop");
  if (stops.length === 1 || steps <= 1) return Array.from({ length: Math.max(1, steps) }, () => stops[0]!);
  const out: string[] = [];
  const segments = stops.length - 1;
  for (let i = 0; i < steps; i++) {
    const pos = (i / (steps - 1)) * segments;
    const seg = Math.min(Math.floor(pos), segments - 1);
    out.push(mix(stops[seg]!, stops[seg + 1]!, pos - seg));
  }
  return out;
}
