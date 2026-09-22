// =============================================================================
// update-check.ts — background "a newer release exists" probe
//
// This runs AFTER the first frame is on screen, never before it. It used to be
// an `await`ed call in entry.ts ahead of the TUI import, which put a GitHub
// round-trip on the critical path to first paint: measured 1.68s vs 0.58s
// time-to-input-ready with the check disabled, i.e. ~65% of startup spent on a
// blank terminal. It also installed and re-exec'd on its own; now it only
// reports, and `freecode update` is the user's to run.
// =============================================================================

import { getVersion } from "./display.js";

// Canonical repo. The old ayandexyz/freecode path still resolves, but via a
// 301 — an extra round-trip on a request made once per launch.
const RELEASES_URL =
  "https://api.github.com/repos/ayandexyz/omacode/releases/latest";

const TIMEOUT_MS = 3000;

/** Same 1/true/yes convention as core's FREECODE_DISABLE_* flags. */
function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * True when `latest` is strictly higher than `current`, comparing
 * dot-separated numeric parts. A non-numeric part (the `rc1` of `0.39.0-rc1`)
 * counts as 0, so a prerelease never advertises itself over its own release,
 * and equal-or-behind answers false — we show the notice only when there is
 * genuinely something newer to move to.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newer release's version, or null when there is nothing to say: running
 * from source (no release to compare against), pinned via FREECODE_NO_UPDATE,
 * already current, or the request failed for any reason at all — offline,
 * rate-limited, GitHub down. Never throws and never blocks anything: the
 * caller fires it and forgets it, and the header stays quiet on null.
 */
export async function checkForUpdate(
  current: string = getVersion(),
): Promise<string | null> {
  if (
    process.env.FREECODE_BUNDLED !== "1" ||
    isEnvTruthy(process.env.FREECODE_NO_UPDATE)
  ) {
    return null;
  }
  try {
    const res = await fetch(RELEASES_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    return latest && isNewerVersion(latest, current) ? latest : null;
  } catch {
    return null;
  }
}
