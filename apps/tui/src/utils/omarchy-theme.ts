import { execFileSync } from "child_process";
import { existsSync, watch, type FSWatcher } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * Omarchy exposes the active theme as a flat `colors.toml` with semantic
 * keys (`accent`, `yellow`, `foreground`, …). The canonical resolver is the
 * `omarchy-theme-color` CLI, which handles aliasing, light/dark detection,
 * and derived shades — we reuse that instead of re-parsing the toml here.
 *
 * `omarchy-theme-set` doesn't notify running TUI clients, so we read once at
 * module init and then WATCH for a switch — see `watchOmarchyTheme`.
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

/** Resolved at startup; `null` means use the default chalk colors. */
export const omarchyPalette: OmarchyPalette | null = loadOmarchyPalette();

/**
 * The directory `omarchy-theme-set` rewrites: it replaces `theme/` wholesale
 * and writes the new name into `theme.name`.
 *
 * Watching the PARENT rather than `theme/colors.toml` is deliberate. A switch
 * replaces the theme directory, so a watch on a file inside it is left holding
 * a stale inode and never fires again — the failure mode is silent, which is
 * worse than not watching at all.
 */
const STATE_DIR = dirname(dirname(COLORS_FILE));

/** Coalesce the burst of events one theme switch produces. */
const DEBOUNCE_MS = 150;

/**
 * Call `onChange` when the active Omarchy theme changes.
 *
 * Returns a stop function. A no-op (and a stop that does nothing) when this is
 * not an Omarchy session, so callers need no platform check of their own.
 *
 * `persistent: false` matters: a watcher that holds the event loop open would
 * stop the TUI process from exiting, and a handle that keeps a finished
 * process alive is a bug this repo has already been bitten by (see TODO.md,
 * `freecode eval` not exiting).
 */
export function watchOmarchyTheme(onChange: () => void): () => void {
  if (process.platform !== "linux" || !existsSync(STATE_DIR)) return () => {};

  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) onChange();
    }, DEBOUNCE_MS);
    timer.unref?.();
  };

  const attach = (): void => {
    if (stopped) return;
    try {
      watcher = watch(STATE_DIR, { persistent: false }, fire);
      // A replaced directory surfaces as an error on some kernels rather than
      // a rename event; reattach instead of going quiet for the session.
      watcher.on("error", reattach);
    } catch {
      reattach();
    }
  };

  const reattach = (): void => {
    if (stopped || retry) return;
    watcher?.close();
    watcher = undefined;
    retry = setTimeout(() => {
      retry = undefined;
      attach();
      // The theme may well have changed during the gap.
      fire();
    }, 500);
    retry.unref?.();
  };

  attach();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
    watcher?.close();
  };
}
