import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustBrightness,
  frameToLines,
  gradient,
  MATRIX_DEFAULTS,
  MatrixEffect,
  mulberry32,
  type Canvas,
  type MatrixOptions,
} from "./matrix-rain.js";

const TEXT = ["  ab  ", " cd e "];

function canvas(height: number): Canvas {
  return { width: 6, height, text: TEXT, finalColorAt: (row) => (row < TEXT.length ? "#ffffff" : undefined) };
}

function build(seed = 1, height = 8, overrides: Partial<MatrixOptions> = {}): MatrixEffect {
  return new MatrixEffect(canvas(height), { ...MATRIX_DEFAULTS, rainTicks: 20, ...overrides, rng: mulberry32(seed) });
}

function runToEnd(effect: MatrixEffect, cap = 5000): number {
  let n = 0;
  while (effect.tick()) {
    n += 1;
    assert.ok(n < cap, `effect did not finish within ${cap} ticks`);
  }
  return n;
}

test("finishes and the final frame is exactly the target text", () => {
  const e = build();
  runToEnd(e);
  assert.equal(e.done, true);
  const lines = frameToLines(e.frame());
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.slice(0, 2), TEXT);
  assert.ok(lines.slice(2).every((l) => l === "      "), "rows below the text end blank");
});

test("every frame is width × height", () => {
  const e = build(7);
  while (e.tick()) {
    const grid = e.frame();
    assert.equal(grid.length, 8);
    for (const row of grid) assert.equal(row.length, 6);
  }
});

test("rain shows up before the deadline and the fill phase covers the canvas", () => {
  const e = build(3, 10);
  let lit = 0;
  for (let i = 0; i < 20; i++) {
    e.tick();
    lit = Math.max(lit, e.frame().flat().filter(Boolean).length);
  }
  assert.ok(lit > 0, "nothing rained during the rain phase");
  let full = 0;
  for (let i = 0; i < 40; i++) {
    e.tick();
    full = Math.max(full, e.frame().flat().filter(Boolean).length);
  }
  assert.equal(full, 60, "fill phase should light every cell at some point");
});

test("same seed, same frames", () => {
  const a = build(42);
  const b = build(42);
  while (a.tick() && b.tick()) assert.deepEqual(a.frame(), b.frame());
});

test("tick after done is a no-op that returns false", () => {
  const e = build();
  runToEnd(e);
  assert.equal(e.tick(), false);
});

test("shrinking mid-effect drops the lost rows and still resolves the text", () => {
  const e = build(11, 12);
  for (let i = 0; i < 30; i++) e.tick();
  e.shrink(7);
  assert.equal(e.height, 7);
  assert.equal(e.frame().length, 7);
  runToEnd(e);
  assert.deepEqual(frameToLines(e.frame()).slice(0, 2), TEXT);
  e.shrink(9); // growing is ignored
  assert.equal(e.height, 7);
});

test("resolved cells take the canvas's colour", () => {
  const e = build(5, 6);
  runToEnd(e);
  const cell = e.frame()[0]![2];
  assert.equal(cell?.sym, "a");
  assert.equal(cell?.fg, "#ffffff");
});

test("colour helpers", () => {
  assert.equal(adjustBrightness("#ffffff", 0.5), "#808080");
  assert.deepEqual(gradient(["#000000", "#ffffff"], 3), ["#000000", "#808080", "#ffffff"]);
  assert.deepEqual(gradient(["#123456"], 1), ["#123456"]);
});
