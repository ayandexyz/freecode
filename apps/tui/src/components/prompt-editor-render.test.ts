// =============================================================================
// Render tests for the borderless composer.
//
// The pure helpers are covered in prompt-editor.test.ts; what those cannot
// catch is how the pieces compose against the real pi-tui Editor — that the
// borders are actually gone, that the prompt occupies exactly the padding the
// base class reserved, that wrapped rows line up under the first typed
// character, and that the rows pi-tui appends after its bottom border
// (autocomplete) survive. Each of those is a place where an off-by-one in the
// slicing silently eats a row of user text, so they are asserted here rather
// than eyeballed.
//
// The Editor needs a TUI only for `terminal.rows` (its max-visible-lines
// budget) and `requestRender`, so a stub stands in for the real terminal.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import type { TUI } from "@earendil-works/pi-tui";

import { PromptEditor } from "./prompt-editor.js";
import { defaultEditorTheme } from "../themes.js";

const WIDTH = 60;

function makeEditor(rows = 20): PromptEditor {
  const tui = {
    terminal: { rows, columns: WIDTH },
    requestRender() {},
  } as unknown as TUI;
  const editor = new PromptEditor(tui, defaultEditorTheme);
  editor.statusLabel = () => "anthropic/opus · build";
  return editor;
}

/** Rendered rows with colour stripped — what the user actually sees. */
function rowsOf(editor: PromptEditor): string[] {
  return editor.render(WIDTH).map((line) => stripAnsi(line));
}

test("render: no box is drawn around the input", () => {
  const rows = rowsOf(makeEditor());
  for (const row of rows) {
    assert.doesNotMatch(row, /[╭╮╰╯│]/, `box drawing survived in: ${row}`);
  }
  // A plain horizontal rule would mean a border row was left behind.
  assert.doesNotMatch(rows[0] ?? "", /^─/);
});

test("render: an idle composer is exactly two rows — input and status", () => {
  const rows = rowsOf(makeEditor());
  // The boxed version cost four (top border, input, bottom border, +chrome).
  // Those two reclaimed rows go to the transcript, so this is the point of
  // the change and worth pinning down.
  assert.equal(rows.length, 2);
  assert.ok(rows[0]?.startsWith("1> "), rows[0]);
  assert.ok(rows[1]?.trimEnd().endsWith("anthropic/opus · build"), rows[1]);
});

test("render: typed text begins immediately after the prompt", () => {
  const editor = makeEditor();
  editor.setText("fix the parser");
  assert.ok(rowsOf(editor)[0]?.startsWith("1> fix the parser"));
});

test("render: the prompt carries the turn number", () => {
  const editor = makeEditor();
  editor.turnNumber = () => 12;
  editor.setText("hi");
  assert.ok(rowsOf(editor)[0]?.startsWith("12> hi"), rowsOf(editor)[0]);
});

test("render: a wider turn number keeps text aligned, not clipped", () => {
  // The prompt is the Editor's left padding, so a 1→2 digit roll has to be
  // applied before layout or the first render after it wraps a column short
  // and drops a character.
  const text = "b".repeat(100);
  const wide = makeEditor();
  wide.turnNumber = () => 12;
  wide.setText(text);
  const rows = rowsOf(wide).slice(0, -1);
  assert.equal(rows.join("").replace(/[^b]/g, "").length, text.length);
  // Continuation rows are indented to sit under the first typed character.
  assert.ok(rows[1]?.startsWith("    b"), rows[1]);
});

test("render: every row is exactly the requested width", () => {
  const editor = makeEditor();
  editor.setText("a".repeat(150));
  for (const row of rowsOf(editor)) {
    assert.equal(row.length, WIDTH, `bad width: ${JSON.stringify(row)}`);
  }
});

test("render: the processing glyph shows only on an empty composer", () => {
  const editor = makeEditor();
  editor.isProcessing = () => true;
  assert.ok(rowsOf(editor)[0]?.startsWith("1… "));
  editor.setText("queued question");
  assert.ok(rowsOf(editor)[0]?.startsWith("1> "));
});

test("render: shell and command do not repeat the symbol the user typed", () => {
  const editor = makeEditor();
  editor.setText("!ls -la");
  assert.ok(rowsOf(editor)[0]?.startsWith("1> !ls -la"), rowsOf(editor)[0]);
  editor.setText("/model");
  assert.ok(rowsOf(editor)[0]?.startsWith("1> /model"), rowsOf(editor)[0]);
});

test("render: the mode is carried by prompt colour, distinctly per mode", () => {
  const editor = makeEditor();
  const promptColour = (): string => {
    const first = editor.render(WIDTH)[0] ?? "";
    return /^(\x1b\[[0-9;]*m)/.exec(first)?.[1] ?? "";
  };
  editor.setText("hello");
  const chat = promptColour();
  editor.setText("!ls");
  const shell = promptColour();
  editor.setText("/model");
  const command = promptColour();
  // Colour is the only mode signal left, so it has to actually differ.
  assert.equal(new Set([chat, shell, command]).size, 3);
  assert.notEqual(chat, "");
});

test("render: a scrolled composer still says how much is hidden", () => {
  // Rescued from the dropped borders: without it a tall pasted prompt
  // truncates with no indication at all.
  const editor = makeEditor(20);
  editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
  const rows = rowsOf(editor);
  assert.match(rows.at(-1) ?? "", /[↑↓] \d+ more/);
  // ...without losing the status label it shares the row with.
  assert.ok(rows.at(-1)?.trimEnd().endsWith("anthropic/opus · build"));
});

test("render: autocomplete rows survive below the status line", async () => {
  const editor = makeEditor();
  editor.setAutocompleteProvider({
    triggerCharacters: ["/"],
    getSuggestions: async () => ({
      prefix: "/m",
      items: [
        { value: "/model", label: "/model", description: "pick a model" },
        { value: "/mode", label: "/mode", description: "cycle mode" },
      ],
    }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  });
  editor.handleInput("/");
  editor.handleInput("m");
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rows = rowsOf(editor);
  assert.ok(editor.isShowingAutocomplete(), "autocomplete did not open");
  assert.ok(
    rows.some((r) => r.includes("/model")) && rows.some((r) => r.includes("/mode")),
    rows.join("\n"),
  );
  // They hang below the status row, which stays put.
  const statusIdx = rows.findIndex((r) => r.includes("anthropic/opus · build"));
  const firstItem = rows.findIndex((r) => r.includes("/model"));
  assert.ok(statusIdx !== -1 && firstItem > statusIdx, `status=${statusIdx} item=${firstItem}`);
});
