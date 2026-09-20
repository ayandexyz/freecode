import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit } from "./edit.js";

test("applyEdit replaces a unique match", () => {
  const result = applyEdit("foo\nbar\nbaz", "bar", "qux", false);
  assert.equal(result, "foo\nqux\nbaz");
});

test("applyEdit throws on an ambiguous match instead of silently picking the last one", () => {
  assert.throws(
    () => applyEdit("x\nx\nx", "x", "y", false),
    /ambiguous: found 3 matches/,
  );
});

test("applyEdit replaceAll still replaces every occurrence of an ambiguous match", () => {
  const result = applyEdit("x\nx\nx", "x", "y", true);
  assert.equal(result, "y\ny\ny");
});

// Phase 4 of docs/specs/2026-09-20-pi-parity-plan.md: typographic
// quotes/dashes on either side match, and the replacement leaves the
// surrounding bytes exactly as they were.
test("applyEdit matches a curly-quoted oldString against an ASCII file", () => {
  const content = `const a = 'x';\nconst msg = "hello" -- world;\nconst b = 2;\n`;
  const result = applyEdit(content, `const msg = “hello” -- world;`, `const msg = "hi";`, false);
  assert.equal(result, `const a = 'x';\nconst msg = "hi";\nconst b = 2;\n`);
});

test("applyEdit matches an ASCII oldString against a file with em-dashes and curly quotes", () => {
  const content = `// intro — read this\nconst s = ‘it’;\n`;
  const result = applyEdit(content, `const s = 'it';`, `const s = "it";`, false);
  // The comment line, with its em-dash, is untouched.
  assert.equal(result, `// intro — read this\nconst s = "it";\n`);
});

test("applyEdit still fails closed when the normalized match is ambiguous", () => {
  const content = `x = ‘a’;\nx = ‘a’;\n`;
  assert.throws(() => applyEdit(content, `x = 'a';`, `x = 'b';`, false), /ambiguous/);
});
