import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Omarchy exposes the active theme as a flat `colors.toml` with semantic
 * keys (`accent`, `yellow`, `foreground`, …). The canonical resolver is the
 * `omarchy-theme-color` CLI, which handles aliasing, light/dark detection,
 * and derived shades — we reuse that instead of re-parsing the toml here.
 *
 * The TUI is a long-lived process and the theme is fixed for the session
 * (`omarchy-theme-set` doesn't notify running TUI clients), so we read once
 * at module init.
 */

export type OmarchyPalette = { accent: string; yellow: string };

// Same path omarchy-theme-color reads by default; its presence is what makes
// this an Omarchy session. Checked before spawning so other OSes never pay
// for a process lookup.
const COLORS_FILE = join(homedir(), ".local/state/omarchy/current/theme/colors.toml");

const HEX = /^#[0-9a-f]{6}$/i;

function readColor(key: string, fallbackKey: string): string | null {
  try {
    const out = execFileSync("omarchy-theme-color", [key, fallbackKey], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // The CLI echoes the fallback verbatim when nothing resolves, so only a
    // real hex value counts.
    return HEX.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Omarchy theme palette, or `null` when not running on Omarchy
 * (no active theme file, CLI missing, or non-hex output).
 */
export function loadOmarchyPalette(): OmarchyPalette | null {
  if (process.platform !== "linux" || !existsSync(COLORS_FILE)) return null;
  const accent = readColor("accent", "yellow");
  const yellow = readColor("yellow", "foreground");
  if (!accent || !yellow) return null;
  return { accent, yellow };
}

/** Resolved once per session; `null` means use the default chalk yellows. */
export const omarchyPalette: OmarchyPalette | null = loadOmarchyPalette();
