// =============================================================================
// The palette facade must stay LIVE.
//
// The failure this guards against is silent: a component captures a paint at
// module scope (`const accent = palette.accent`), the theme changes, and that
// one component keeps painting in the old colours. It looks like a render bug,
// not a palette bug, and only on Omarchy after a theme switch.
//
// So the assertion is not "refreshPalette returns true" — it is "a reference
// captured BEFORE the switch paints differently AFTER it", which is exactly
// what every consumer does.
// =============================================================================

import assert from "node:assert";
import { describe, it } from "node:test";
import { palette, refreshPalette } from "./palette.js";
import { OMARCHY_KEYS, type OmarchyPalette } from "./utils/omarchy-theme.js";

/** A complete, obviously-distinct palette — every key a different hex. */
function fakeTheme(seed: number): OmarchyPalette {
  const theme = {} as OmarchyPalette;
  OMARCHY_KEYS.forEach((key, i) => {
    theme[key] = `#${(((i + 1) * 7 + seed * 53) % 256).toString(16).padStart(2, "0")}4488`;
  });
  return theme;
}

/** Strip nothing — we compare raw ANSI, which is the point. */
function paintedWith(fn: (t: string) => string): string {
  return fn("x");
}

describe("palette facade", () => {
  it("exposes every paint as a callable that survives capture", () => {
    // Capture the way a component does, at module scope, before any switch.
    const captured = {
      accent: palette.accent,
      bgAccent: palette.bgAccent,
      syntaxKeyword: palette.syntax.keyword,
    };
    for (const [name, fn] of Object.entries(captured)) {
      assert.equal(typeof fn, "function", `${name} is not callable`);
      assert.ok(paintedWith(fn).includes("x"), `${name} dropped its text`);
    }
  });

  it("keeps segments and shimmer object identity, so captures stay live", () => {
    // `context-report.ts` holds `palette.segments` for the life of the process.
    const segments = palette.segments;
    const shimmer = palette.shimmer;
    assert.strictEqual(palette.segments, segments);
    assert.strictEqual(palette.shimmer, shimmer);
  });

  it("exposes segmentFree as a getter, not a frozen string", () => {
    const descriptor = Object.getOwnPropertyDescriptor(palette, "segmentFree");
    assert.ok(descriptor?.get, "segmentFree must be a getter — a hoisted string goes stale");
    assert.equal(typeof palette.segmentFree, "string");
  });

  it("covers every paint on the interface", () => {
    // A key added to Palette but missed by buildFacade would be `undefined`
    // here and would throw at render time on the first theme switch.
    for (const [key, value] of Object.entries(palette)) {
      if (key === "syntax" || key === "segments" || key === "shimmer") continue;
      if (key === "segmentFree") continue;
      assert.equal(typeof value, "function", `palette.${key} is not a paint`);
    }
    for (const [key, value] of Object.entries(palette.syntax)) {
      assert.equal(typeof value, "function", `palette.syntax.${key} is not a paint`);
    }
  });

  it("repaints a reference captured BEFORE the theme changed", () => {
    // This is the real contract. Every consumer captures like this.
    const accent = palette.accent;
    const chipBg = palette.bgAccent;
    const keyword = palette.syntax.keyword;
    const segments = palette.segments;

    refreshPalette(() => fakeTheme(1));
    const before = [accent("x"), chipBg("x"), keyword("x")];
    const segBefore = segments["tools"];

    const changed = refreshPalette(() => fakeTheme(2));
    assert.equal(changed, true, "a different theme must report a change");

    const after = [accent("x"), chipBg("x"), keyword("x")];
    for (let i = 0; i < before.length; i++) {
      assert.notEqual(after[i], before[i], `captured paint ${i} did not follow the theme`);
    }
    // Same object, new contents — the captured reference must see them.
    assert.strictEqual(palette.segments, segments);
    assert.notEqual(segments["tools"], segBefore, "segments mutated out of place");
  });

  it("reports no change when the theme is identical", () => {
    refreshPalette(() => fakeTheme(3));
    assert.equal(refreshPalette(() => fakeTheme(3)), false, "should not repaint for free");
  });

  it("keeps the last valid palette when the read fails", () => {
    refreshPalette(() => fakeTheme(4));
    const accent = palette.accent;
    const good = accent("x");
    assert.equal(refreshPalette(() => null), false, "a failed read is not a change");
    assert.equal(accent("x"), good, "a mid-swap read must not flash the defaults");
  });
});
