// =============================================================================
// Tests for the borderless composer's pure helpers: the turn-numbered prompt
// prefix, its mode classification, and the dim status row under the input.
// The full PromptEditor needs a pi-tui TUI + Terminal which is heavy to set
// up in node:test, so the render math lives in exported functions and is
// covered here directly.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";

import {
  buildStatusLine,
  composerMode,
  formatHistoryIndicator,
  promptGlyph,
  promptPrefix,
  scrollNotice,
} from "./prompt-editor.js";

const IDENTITY = (s: string) => s;

test("formatHistoryIndicator: returns null when not browsing history", () => {
  assert.equal(formatHistoryIndicator(-1, 12), null);
  assert.equal(formatHistoryIndicator(-1, 0), null);
});

test("formatHistoryIndicator: returns null when the ring is empty", () => {
  assert.equal(formatHistoryIndicator(0, 0), null);
  // Defensive: forced into the "browsing" branch with total=0 still no-ops.
  assert.equal(formatHistoryIndicator(2, 0), null);
});

test("formatHistoryIndicator: 1-based from the most recent entry", () => {
  assert.equal(formatHistoryIndicator(0, 5), "[1/5]");
  assert.equal(formatHistoryIndicator(2, 12), "[3/12]");
  assert.equal(formatHistoryIndicator(7, 100), "[8/100]");
});

test("composerMode: a leading ! is shell, even with a slash after it", () => {
  assert.equal(composerMode("!ls -la", false), "shell");
  // `!` is matched on the raw text before the slash test, mirroring how
  // index.ts dispatches a submitted prompt: bang first, then slash.
  assert.equal(composerMode("!/usr/bin/env", false), "shell");
  assert.equal(composerMode("!!git status", false), "shell");
});

test("composerMode: a leading slash is a command, leading space allowed", () => {
  assert.equal(composerMode("/model", false), "command");
  assert.equal(composerMode("  /help", false), "command");
  // Mid-text, a slash is just a path.
  assert.equal(composerMode("read src/index.ts", false), "chat");
});

test("composerMode: processing only shows on an empty composer", () => {
  assert.equal(composerMode("", true), "processing");
  // Once typing starts, what Enter will do outranks what the agent is doing.
  assert.equal(composerMode("next question", true), "chat");
  assert.equal(composerMode("/model", true), "command");
  assert.equal(composerMode("", false), "chat");
});

test("promptGlyph: every mode is the same visible width", () => {
  const widths = new Set(
    (["chat", "command", "shell", "processing"] as const).map((m) => promptGlyph(m).length),
  );
  // A mode switch must not reflow the line the user is typing on.
  assert.equal(widths.size, 1);
});

test("promptPrefix: the label precedes the glyph", () => {
  assert.equal(promptPrefix("main", "chat"), "main> ");
  assert.equal(promptPrefix(1, "chat"), "1> ");
  // Shell and command keep `>`; the typed `!`/`/` already says the mode, so
  // it is carried by colour instead of a second symbol.
  assert.equal(promptPrefix(12, "shell"), "12> ");
  assert.equal(promptPrefix(3, "command"), "3> ");
  assert.equal(promptPrefix(7, "processing"), "7… ");
});

test("buildStatusLine: returns null when there is nothing to show", () => {
  assert.equal(buildStatusLine(40, null, null), null);
  assert.equal(buildStatusLine(40, null, ""), null);
});

test("buildStatusLine: the label sits against the right edge", () => {
  const line = stripAnsi(buildStatusLine(40, null, "anthropic/opus · build") ?? "");
  assert.equal(line.length, 40);
  assert.ok(line.endsWith("anthropic/opus · build"));
});

test("buildStatusLine: the indicator is indented to the prompt column", () => {
  const line = stripAnsi(buildStatusLine(40, "[3/12]", "model · plan", 3) ?? "");
  assert.equal(line.length, 40);
  assert.ok(line.startsWith("   [3/12]"), line);
  assert.ok(line.endsWith("model · plan"));
});

test("buildStatusLine: a label that would collide with the indicator is dropped", () => {
  const line = stripAnsi(buildStatusLine(14, "[3/12]", "a-very-long-model · build", 3) ?? "");
  // The indicator is transient and is what the user is looking at, so it is
  // the label that goes rather than the line wrapping.
  assert.doesNotMatch(line, /model/);
  assert.ok(line.includes("[3/12]"));
});

test("scrollNotice: a plain border carries nothing", () => {
  assert.equal(scrollNotice("─".repeat(40)), null);
  assert.equal(scrollNotice(""), null);
});

test("scrollNotice: the indicator survives being dropped with the border", () => {
  // Without this the borderless composer would silently truncate a tall
  // pasted prompt — the one thing the borders said that the prompt does not.
  assert.equal(scrollNotice("─── \u2191 6 more " + "─".repeat(20)), "\u2191 6 more");
  assert.equal(scrollNotice("\x1b[33m─── \u2193 12 more ───\x1b[39m"), "\u2193 12 more");
});
