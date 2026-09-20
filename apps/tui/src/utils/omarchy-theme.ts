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

/** Every key the TUI palette maps. Names follow colors.toml. */
export const OMARCHY_KEYS = [
  "accent",
  "muted",
  "selection",
  "background",
  "lighter_background",
  "foreground",
  "bright_foreground",
  "red",
  "green",
  "yellow",
  "orange",
  "blue",
  "magenta",
  "cyan",
  "bright_red",
  "bright_green",
  "bright_yellow",
  "bright_blue",
  "bright_magenta",
  "bright_cyan",
] as const;

export type OmarchyKey = (typeof OMARCHY_KEYS)[number];
export type OmarchyPalette = Record<OmarchyKey, string>;

// Same path omarchy-theme-color reads by default; its presence is what makes
// this an Omarchy session. Checked before spawning so other OSes never pay
// for a process lookup.
const COLORS_FILE = join(homedir(), ".local/state/omarchy/current/theme/colors.toml");

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Resolve the Omarchy theme palette, or `null` when not running on Omarchy
 * (no active theme file, CLI missing, or a key the CLI cannot resolve).
 *
 * One `--all` call rather than one process per key: the CLI already applies
 * its alias/fallback cascade to every key, and twenty spawns at startup is
 * a visible delay.
 */
export function loadOmarchyPalette(): OmarchyPalette | null {
  if (process.platform !== "linux" || !existsSync(COLORS_FILE)) return null;
  let out: string;
  try {
    out = execFileSync("omarchy-theme-color", ["--all"], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const resolved = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [key, value] = line.split("\t");
    if (key && value && HEX.test(value)) resolved.set(key, value);
  }
  const palette = {} as OmarchyPalette;
  for (const key of OMARCHY_KEYS) {
    const value = resolved.get(key);
    if (!value) return null;
    palette[key] = value;
  }
  return palette;
}

/** Resolved once per session; `null` means use the default chalk colors. */
export const omarchyPalette: OmarchyPalette | null = loadOmarchyPalette();
