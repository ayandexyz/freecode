import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ListSource, MenuCard } from "./menu-card.js";
import { SlashMenuModel, type MenuCommand } from "./slash-menu-model.js";

function plain(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const COMMANDS: MenuCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Select an API model" },
  { name: "effort", description: "Set reasoning effort" },
  { name: "resume", description: "Resume a previous session" },
  { name: "review", description: "Review the diff", argHint: "[focus]" },
  { name: "exit", description: "Exit FreeCode" },
];

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

function setup() {
  const menu = new MenuCard(new SlashMenuModel(COMMANDS), () => 30, false);
  const events: string[] = [];
  menu.onPick = (r) => events.push(`run:${r.command?.name}`);
  menu.onClose = () => events.push("close");
  menu.onHandBack = (t) => events.push(`back:${t}`);
  return { menu, events, text: () => menu.render(50).map(plain).join("\n") };
}

test("root lists non-empty groups, unknown commands under Prompts, then root leaves", () => {
  const rows = new SlashMenuModel(COMMANDS).rows(null).map((r) => r.label);
  assert.deepEqual(rows, ["Model", "Session", "Prompts", "help", "exit"]);
});

test("search ranks name prefix over description word", () => {
  const rows = new SlashMenuModel(COMMANDS).search("re").map((r) => r.id);
  assert.deepEqual(rows.slice(0, 2), ["resume", "review"]);
  assert.ok(rows.includes("effort"), "description word 'reasoning' matches");
});

test("header reads Go… at root and the group title inside it", () => {
  const { menu, text } = setup();
  assert.match(text(), /Go…/);
  menu.handleInput(ENTER); // Model
  assert.match(text(), /Model…/);
  assert.match(text(), /effort/);
});

test("every row is exactly the requested width", () => {
  const { menu } = setup();
  for (const line of menu.render(50)) assert.equal(visibleWidth(line), 50);
});

test("enter on a leaf runs it; left steps back to the group row", () => {
  const { menu, events, text } = setup();
  menu.handleInput(DOWN); // Session
  menu.handleInput(ENTER);
  menu.handleInput(LEFT);
  assert.match(text(), /Go…/);
  menu.handleInput(ENTER); // cursor restored onto Session
  menu.handleInput(ENTER); // resume
  assert.deepEqual(events, ["run:resume"]);
});

test("typing searches; esc clears the query before closing", () => {
  const { menu, events, text } = setup();
  for (const ch of "eff") menu.handleInput(ch);
  assert.match(text(), /effort\s+Set reasoning effort/);
  menu.handleInput(ESC);
  assert.match(text(), /Go…/);
  menu.handleInput(ESC);
  assert.deepEqual(events, ["close"]);
});

test("a path or a space hands the text back to the editor", () => {
  const { menu, events } = setup();
  for (const ch of "home") menu.handleInput(ch);
  menu.handleInput("/");
  assert.deepEqual(events, ["back:/home/"]);
});

test("enter with no match hands the query back; backspace at root closes", () => {
  const { menu, events } = setup();
  for (const ch of "zzz") menu.handleInput(ch);
  menu.handleInput(ENTER);
  const fresh = setup();
  fresh.menu.handleInput(BACKSPACE);
  assert.deepEqual([...events, ...fresh.events], ["back:/zzz", "close"]);
});

function listSetup() {
  const rows = [
    { id: "claude-opus", label: "Claude Opus", status: "✓" },
    { id: "gpt/5", label: "GPT 5", description: "openai flagship" },
  ];
  const card = new MenuCard(new ListSource("Anthropic", rows), () => 30, false);
  const events: string[] = [];
  card.onPick = (r) => events.push(`pick:${r.id}`);
  card.onBack = () => events.push("back");
  card.onClose = () => events.push("close");
  return { card, events, text: () => card.render(40).map(plain).join("\n") };
}

test("a list card titles itself and keeps / and spaces in the query", () => {
  const { card, events, text } = listSetup();
  assert.match(text(), /Anthropic…/);
  for (const ch of "gpt/") card.handleInput(ch);
  card.handleInput(ENTER);
  assert.deepEqual(events, ["pick:gpt/5"]);
});

test("a list card searches descriptions and backs out through onBack", () => {
  const { card, events, text } = listSetup();
  for (const ch of "flag") card.handleInput(ch);
  assert.match(text(), /GPT 5/);
  assert.doesNotMatch(text(), /Claude Opus/);
  card.handleInput(ESC);
  card.handleInput(LEFT);
  assert.deepEqual(events, ["back"]);
});

test("status stays right-aligned inside the card", () => {
  const { card } = listSetup();
  const row = card.render(40).map(plain).find((l) => l.includes("Claude Opus"))!;
  assert.match(row, /✓ │$/);
  for (const line of card.render(40)) assert.equal(visibleWidth(line), 40);
});

test("the selection band covers a truncated row to the border, ellipsis included", () => {
  const rows = [
    { id: "cf", label: "Cloudflare Workers AI Gateway Extended", status: "\x1b[32mnot configured\x1b[39m" },
  ];
  const card = new MenuCard(new ListSource("Provider", rows), () => 30, false);
  const row = card.render(40).find((l) => plain(l).includes("Cloudflare"))!;
  // The band opens once and closes once, and everything between the two
  // borders — ellipsis and status included — sits inside it.
  const band = row.slice(row.indexOf("\x1b[48;"), row.indexOf("\x1b[49m"));
  assert.doesNotMatch(band, /\x1b\[0m/);
  assert.equal(visibleWidth(band), 38);
  assert.match(plain(band), /\.\.\. not configured $/);
  assert.equal(visibleWidth(row), 40);
});
