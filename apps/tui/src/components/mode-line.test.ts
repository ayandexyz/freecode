import test from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { ModeLine } from "./mode-line.js";
import { palette } from "../palette.js";

// ModeLine paints through the DEFAULT chalk instance, which auto-detects and
// lands on level 0 under the test runner — themes.ts forces level 3 for its own
// instance, which is why a colour assertion here would otherwise only ever be
// matching the mode chip. Force it so the chip assertions test the real thing.
chalk.level = 3;

// \u001b escape rather than a literal ESC byte: a bare "[…m" pattern
// leaves the escape character behind and every width assertion is then off.
const ANSI = /\u001b\[[0-9;]*m/g;

function line(running: number, width = 100, agents = 0): string {
  const modeLine = new ModeLine(() => false, () => running, () => agents);
  return modeLine.render(width)[0] ?? "";
}

const strip = (s: string): string => s.replace(ANSI, "");

// The chips paint with whatever the palette resolved (the Omarchy theme on
// Omarchy, fixed hexes elsewhere), so assert on the palette's own escape
// rather than a literal colour.
const bgCode = (paint: (t: string) => string): string => {
  const code = paint("x").match(/^\u001b\[48;2;\d+;\d+;\d+m/)?.[0];
  assert.ok(code, "palette background did not produce a truecolor escape");
  return code;
};
const SHELLS_BG = bgCode(palette.bgAccent);
const AGENTS_BG = bgCode(palette.bgAccent2);

test("shows a /shells chip with the running count, right-aligned", () => {
  const rendered = strip(line(2));
  assert.match(rendered, /\/shells \(2\)/);
  assert.equal(rendered.length, 100);
});

test("no chip when nothing is running", () => {
  // A permanent chip reading (0) is chrome, not information.
  assert.doesNotMatch(strip(line(0)), /\/shells/);
});

test("the chip is painted, not plain text", () => {
  // The point of the chip is that it is visible at a glance; if the background
  // escape ever gets dropped it degrades to unnoticeable dim text.
  assert.ok(line(1).includes(SHELLS_BG));
});

test("the chip is width-neutral: it never lengthens the line", () => {
  // A line one column too long wraps and pushes the input box off screen.
  for (const width of [70, 80, 90, 100, 120, 140]) {
    assert.equal(strip(line(3, width)).length, width);
  }
});

test("the chip drops out rather than overflowing a narrow terminal", () => {
  // The count is one keystroke away in /shells, so on a terminal too narrow
  // for it the chip is what yields.
  assert.doesNotMatch(strip(line(3, 10)), /\/shells/);
  assert.match(strip(line(3, 100)), /\/shells \(3\)/);
});

test("renders nothing when neither chip is showing", () => {
  const modeLine = new ModeLine(() => false);
  assert.deepEqual(modeLine.render(100), []);
});

test("shows an /agents chip with the running subagent count", () => {
  const rendered = strip(line(0, 100, 3));
  assert.match(rendered, /\/agents \(3\)/);
});

test("no /agents chip when nothing is delegating", () => {
  assert.doesNotMatch(strip(line(0, 100, 0)), /\/agents/);
});

test("the /agents chip is painted in its own colour, not the shells accent", () => {
  assert.notEqual(AGENTS_BG, SHELLS_BG);
  assert.ok(line(0, 100, 1).includes(AGENTS_BG));
});

test("both chips fit together, agents outside shells", () => {
  const rendered = strip(line(2, 140, 3));
  assert.match(rendered, /\/agents \(3\)/);
  assert.match(rendered, /\/shells \(2\)/);
  assert.ok(
    rendered.indexOf("/agents") < rendered.indexOf("/shells"),
    "agents sits outside shells",
  );
});

test("neither chip lengthens the line, alone or together", () => {
  for (const width of [70, 80, 90, 100, 120, 140]) {
    assert.equal(strip(line(0, width, 3)).length, width, `agents chip at ${width}`);
    assert.equal(strip(line(2, width, 3)).length, width, `both chips at ${width}`);
  }
});

test("under a squeeze the agents chip yields before the shells one", () => {
  // Budget is spent right-to-left, so the shells chip survives. Asserted as
  // an invariant over every width rather than at one magic column.
  for (let width = 5; width <= 60; width++) {
    const rendered = strip(line(2, width, 3));
    if (rendered.includes("/agents")) {
      assert.ok(
        rendered.includes("/shells"),
        `at ${width} the agents chip survived a squeeze the shells chip did not`,
      );
    }
  }
  // And there is genuinely a width where only one of them fits, or the
  // assertion above is vacuous.
  const widths = [];
  for (let width = 5; width <= 60; width++) {
    const rendered = strip(line(2, width, 3));
    if (rendered.includes("/shells") && !rendered.includes("/agents")) {
      widths.push(width);
    }
  }
  assert.ok(
    widths.length > 0,
    "expected a width where only the shells chip fits",
  );
});

test("defaults to no /agents chip when the count getter is not supplied", () => {
  const modeLine = new ModeLine(() => false, () => 1);
  assert.doesNotMatch(strip(modeLine.render(120)[0] ?? ""), /\/agents/);
});
