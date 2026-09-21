import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CacheStats } from "@thisisayande/freecode-shared";
import { ContextBox } from "./context-box.js";

//  escape rather than a literal ESC byte — see mode-line.test.ts.
const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

function render(
  stats: CacheStats | undefined,
  rate: number | undefined = undefined,
): string[] {
  const box = new ContextBox(
    () => true,
    () => 12_300,
    () => 200_000,
    () => rate,
    () => stats,
  );
  return box.render(box.width()).map(strip);
}

const stats = (over: Partial<CacheStats> = {}): CacheStats => ({
  yieldPct: 99,
  lastYieldPct: 99,
  lastPct: 97,
  sessionPct: 91,
  misses: [],
  ...over,
});

test("without stats the plain last-run rate stands in", () => {
  assert.deepEqual(render(undefined, 87).map((l) => l.trim()), [
    "12.3K / 200.0K",
    "cache 87%",
  ]);
});

test("stats render jcode's yield · last · session line and an empty list", () => {
  const lines = render(stats()).map((l) => l.trim());
  assert.deepEqual(lines, [
    "12.3K / 200.0K",
    "yield 99% · last 97% · session 91%",
    "miss attribution",
    "none",
  ]);
});

test("before the second call yield reads as priming", () => {
  const lines = render(stats({ yieldPct: undefined, lastYieldPct: undefined }));
  assert.match(lines[1], /priming · last 97% · session 91%/);
});

test("misses list the turn label, tokens and reason, newest last", () => {
  const lines = render(
    stats({
      misses: [
        {
          turn: { run: 2, call: 1 },
          missedTokens: 40_100,
          reason: "model switch",
          harnessBug: false,
        },
        {
          turn: { run: 3, call: 2 },
          missedTokens: 12_000,
          reason: "harness: prefix rewritten",
          harnessBug: true,
        },
      ],
    }),
  ).map((l) => l.trim());
  assert.deepEqual(lines.slice(2), [
    "miss attribution",
    "52.1k missed total",
    "2> 40.1k miss (model switch)",
    "3.2> 12.0k miss (harness: prefix rewritten)",
  ]);
});

test("more than five misses fold into a count", () => {
  const misses = Array.from({ length: 7 }, (_, i) => ({
    turn: { run: i + 1, call: 1 },
    missedTokens: 2_000,
    reason: "expired",
    harnessBug: false,
  }));
  const lines = render(stats({ misses })).map((l) => l.trim());
  assert.equal(lines.filter((l) => l.endsWith("(expired)")).length, 5);
  assert.equal(lines.at(-1), "… 2 more");
  // The oldest two are the ones folded.
  assert.equal(lines[4], "3> 2.0k miss (expired)");
});

test("every line is right-aligned to the fixed width, colour codes ignored", () => {
  const box = new ContextBox(
    () => true,
    () => 1,
    () => 10,
    () => undefined,
    () =>
      stats({
        misses: [
          {
            turn: { run: 12, call: 3 },
            missedTokens: 999_900,
            reason: "compaction: auto compaction: 190000 → 40000 tokens",
            harnessBug: false,
          },
        ],
      }),
  );
  for (const line of box.render(box.width())) {
    assert.equal(visibleWidth(line), box.width(), strip(line));
  }
});
