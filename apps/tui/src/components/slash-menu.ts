import {
  Key,
  decodeKittyPrintable,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { palette } from "../palette.js";
import { isPrintable } from "./searchable-select-list.js";
import type { MenuCommand, MenuRow, SlashMenuModel } from "./slash-menu-model.js";

const PAGE = 6;
/** Rows the card costs besides the list: borders, header, and the blank under it. */
const CHROME_ROWS = 4;
const HINT = " ↑↓ move · → open · ← back · esc ";

/**
 * The `/` menu — the Omarchy menu, drawn in the terminal. A header that reads
 * `Go…` until you type, then shows the query; category rows that open with
 * `›`; a search that flattens every command into one ranked list. Esc clears
 * the query first and closes second, ← / backspace step back out of a
 * category, exactly as the desktop menu does.
 *
 * Typing past what the menu can match hands the text back to the editor:
 * `/home/me/repo fix this` is a prompt, not a command, so a `/` or a space in
 * the query, or Enter with no match, closes the menu and leaves `/<query>` in
 * the composer.
 */
export class SlashMenu implements Component {
  private group: string | null = null;
  private query = "";
  private cursor = 0;
  private scroll = 0;

  /** A leaf was chosen. */
  onRun?: (command: MenuCommand) => void;
  /** Closed without running anything. */
  onClose?: () => void;
  /** The query is not a menu search after all — put it in the editor. */
  onHandBack?: (text: string) => void;

  constructor(
    private readonly model: SlashMenuModel,
    private readonly maxRows: () => number,
    private readonly icons: boolean,
  ) {}

  private rows(): MenuRow[] {
    return this.query ? this.model.search(this.query) : this.model.rows(this.group);
  }

  private setQuery(query: string): void {
    this.query = query;
    this.cursor = 0;
    this.scroll = 0;
  }

  private open(group: string | null): void {
    this.group = group;
    this.setQuery("");
  }

  private back(): void {
    if (this.group === null) {
      this.onClose?.();
      return;
    }
    const from = this.group;
    this.open(null);
    this.cursor = Math.max(0, this.rows().findIndex((r) => r.id === from));
  }

  private activate(): void {
    const row = this.rows()[this.cursor];
    if (!row) {
      if (this.query) this.onHandBack?.(`/${this.query}`);
      return;
    }
    if (row.command) this.onRun?.(row.command);
    else this.open(row.id);
  }

  private move(delta: number, wrap: boolean): void {
    const n = this.rows().length;
    if (n === 0) return;
    const next = this.cursor + delta;
    this.cursor = wrap ? (next + n) % n : Math.min(n - 1, Math.max(0, next));
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (matchesKey(data, Key.escape)) {
      if (this.query) this.setQuery("");
      else this.onClose?.();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.query) this.setQuery(this.query.slice(0, -1));
      else this.back();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (!this.query) this.back();
      return;
    }
    if (matchesKey(data, Key.right) || kb.matches(data, "tui.select.confirm")) {
      this.activate();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1, true);
    if (matchesKey(data, Key.down)) return this.move(1, true);
    if (matchesKey(data, Key.pageUp)) return this.move(-PAGE, false);
    if (matchesKey(data, Key.pageDown)) return this.move(PAGE, false);

    const kitty = decodeKittyPrintable(data);
    const text = kitty !== undefined ? kitty : isPrintable(data) ? data : undefined;
    if (!text) return;
    if (/[\s/]/.test(text)) {
      this.onHandBack?.(`/${this.query}${text}`);
      return;
    }
    this.setQuery(this.query + text);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const border = palette.accent("│");
    const line = (text: string): string => {
      const clipped = truncateToWidth(text, inner);
      return border + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border;
    };

    const header = this.query
      ? palette.fgBright(this.query) + palette.accent("▏")
      : palette.muted(`${this.model.title(this.group)}…`);
    const out = [palette.accent("╭" + "─".repeat(inner) + "╮"), line(`  ${header}`), line("")];

    const rows = this.rows();
    const visible = Math.max(1, Math.min(rows.length, this.maxRows() - CHROME_ROWS));
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + visible) this.scroll = this.cursor - visible + 1;
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - visible));

    if (rows.length === 0) out.push(line(palette.muted("  No matching command — enter to send as text")));
    rows.slice(this.scroll, this.scroll + visible).forEach((row, i) => {
      out.push(line(this.renderRow(row, this.scroll + i === this.cursor, inner)));
    });

    const hint = inner >= HINT.length + 2 ? HINT : "";
    out.push(palette.accent("╰─" + hint + "─".repeat(Math.max(0, inner - 1 - hint.length)) + "╯"));
    return out;
  }

  private renderRow(row: MenuRow, selected: boolean, inner: number): string {
    const icon = this.icons ? `${row.icon || " "}  ` : "";
    const label = row.command?.argHint ? `${row.label} ${row.command.argHint}` : row.label;
    const trail = row.command ? "" : "›";
    // Descriptions only while searching, as in the desktop menu: browsing a
    // category is by name, a search result needs to say what it does.
    const detail = this.query && row.command ? `  ${row.command.description}` : "";
    const left = ` ${icon}${label}`;
    const room = inner - 1 - visibleWidth(left) - trail.length - 1;
    const desc = room > 3 && detail ? truncateToWidth(detail, room) : "";
    const gap = " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(desc) - trail.length - 1));
    if (selected) {
      return palette.bgSelection(palette.fgSelection(`${left}${desc}${gap}${trail} `));
    }
    return `${left}${palette.muted(desc)}${gap}${palette.muted(trail)} `;
  }
}
