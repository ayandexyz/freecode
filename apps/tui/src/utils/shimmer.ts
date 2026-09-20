import { Chalk } from "chalk";
import { mix, palette } from "../palette.js";

// Level 3 for the same reason as palette.ts: the blend only exists in truecolor.
const chalk = new Chalk({ level: 3 });

/** Characters lit on either side of the band's centre. */
const BAND = 3;
/** Cells the band advances per second. */
const CELLS_PER_SECOND = 14;
/** Distinct brightness levels; paints are built once, not per character. */
const STEPS = 6;

let paints: ((text: string) => string)[] | null = null;

function paintFor(intensity: number): (text: string) => string {
  paints ??= Array.from({ length: STEPS + 1 }, (_, i) =>
    chalk.hex(mix(palette.shimmer.base, palette.shimmer.glow, i / STEPS)),
  );
  return paints[Math.round(intensity * STEPS)]!;
}

/**
 * Paint `text` in the shimmer's resting tone with a soft highlight sweeping
 * left to right — the Claude Code "glass" effect on its working phrase. The
 * band position is derived from the clock so every caller stays in step and
 * nothing needs its own timer; the caller just has to re-render often enough
 * (~100ms) for the motion to read as smooth.
 */
export function shimmer(text: string, now = Date.now()): string {
  const chars = Array.from(text);
  // The band starts fully off the left edge and runs fully off the right, so
  // there is a beat of plain text between sweeps rather than a hard wrap.
  const span = chars.length + BAND * 2;
  const centre = ((now / 1000) * CELLS_PER_SECOND) % span - BAND;

  let out = "";
  let run = "";
  let runPaint: ((text: string) => string) | null = null;
  for (let i = 0; i < chars.length; i++) {
    const intensity = Math.max(0, 1 - Math.abs(i - centre) / BAND);
    const paint = paintFor(intensity);
    if (paint !== runPaint) {
      if (runPaint) out += runPaint(run);
      run = "";
      runPaint = paint;
    }
    run += chars[i];
  }
  if (runPaint) out += runPaint(run);
  return out;
}
