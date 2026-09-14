// =============================================================================
// Tests for renderCodeBlock — the markdown code-block highlighter that gives
// AI-supplied code samples Dracula syntax colors.
// =============================================================================
//
// Chalk auto-detects color support from the TTY/NO_COLOR/FORCE_COLOR env.
// node:test runs in a non-TTY pipe, so we set FORCE_COLOR before the dynamic
// import of diff-view (which transitively imports chalk). Setting it via a
// dynamic import is required because ESM hoists static `import` statements
// to the top of the module — env mutations at the top of the file run AFTER
// those imports, which is too late to affect chalk's level.
import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

process.env.FORCE_COLOR = "1";
const { renderCodeBlock } = await import("./code-block.js");

// Every line is indented two columns so the block stands off the prose.
const INDENT = "  ";

test("renderCodeBlock: indents every line, with no line-number gutter", () => {
  // Fences carry commit messages and config as often as code; numbering
  // those read as noise, so the gutter is gone for every language.
  const lines = renderCodeBlock("const a = 1;\nconst b = 2;", "ts");
  assert.equal(lines.length, 2);
  const stripped = lines.map(stripAnsi);
  assert.equal(stripped[0], `${INDENT}const a = 1;`);
  assert.equal(stripped[1], `${INDENT}const b = 2;`);
  assert.doesNotMatch(stripped[0], /│/);
});

test("renderCodeBlock: highlights tokens for a known language", () => {
  // Use a line rich in tokenizable parts: `// hello world` is a TS comment
  // and cli-highlight emits SGR for it.
  const lines = renderCodeBlock("// hello world", "ts");
  const withAnsi = lines[0];
  const stripped = stripAnsi(withAnsi);
  assert.ok(stripped.includes("// hello world"), `missing code in: ${stripped}`);
  assert.ok(withAnsi.includes("\x1b["), "expected ANSI codes from cli-highlight");
});

test("renderCodeBlock: falls back to raw text when lang is unsupported", () => {
  // "klingon" isn't a real language; supportsLanguage returns false
  const lines = renderCodeBlock("hello world", "klingon");
  assert.equal(stripAnsi(lines[0]), `${INDENT}hello world`);
});

test("renderCodeBlock: falls back to raw text when no lang is provided", () => {
  const lines = renderCodeBlock("plain text\nmore text");
  const stripped = lines.map(stripAnsi);
  assert.equal(stripped[0], `${INDENT}plain text`);
  assert.equal(stripped[1], `${INDENT}more text`);
});

test("renderCodeBlock: empty lines are kept as rows", () => {
  const lines = renderCodeBlock("a\n\nb", "ts");
  const stripped = lines.map(stripAnsi);
  assert.equal(stripped.length, 3);
  assert.equal(stripped[0], `${INDENT}a`);
  assert.equal(stripped[1], INDENT);
  assert.equal(stripped[2], `${INDENT}b`);
});

test("renderCodeBlock: empty input returns one empty line", () => {
  const lines = renderCodeBlock("", "ts");
  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]), INDENT);
});

test("renderCodeBlock: maps common Markdown lang aliases", () => {
  // Ensure each common alias doesn't trip the fallback path — we just want
  // no crash for any well-known lang tag.
  for (const lang of ["ts", "typescript", "js", "javascript", "py", "python", "go", "rs", "rust", "json"]) {
    const lines = renderCodeBlock("x = 1", lang);
    const withAnsi = lines[0];
    assert.ok(withAnsi.length > 0, `empty line for lang=${lang}`);
    assert.equal(stripAnsi(withAnsi), `${INDENT}x = 1`, `bad line for lang=${lang}`);
  }
});

test("renderCodeBlock: never throws on malformed input", () => {
  // Whitespace-only lines are the typical cli-highlight hazard. The
  // try/catch fallback must keep us alive.
  assert.doesNotThrow(() => renderCodeBlock("   \n\t\n   ", "ts"));
});
