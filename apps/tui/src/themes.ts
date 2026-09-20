import { Chalk } from "chalk";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import { renderCodeBlock } from "./components/code-block.js";
import { palette } from "./palette.js";

const chalk = new Chalk({ level: 3 });

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => palette.blue(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.dim(text),
};

export const defaultMarkdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold(palette.cyan(text)),
  link: (text: string) => palette.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => palette.yellow(text),
  codeBlock: (text: string) => palette.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => palette.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
  highlightCode: (code: string, lang?: string) => renderCodeBlock(code, lang),
};

export const defaultEditorTheme: EditorTheme = {
  borderColor: (text: string) => palette.accent(text),
  selectList: defaultSelectListTheme,
};

export const MODE_COLORS: Record<
  "plan" | "build" | "review" | "explore" | "danger",
  (text: string) => string
> = {
  plan: (text: string) => palette.brightBlue(text),
  build: (text: string) => palette.accent(text),
  review: (text: string) => palette.brightGreen(text),
  explore: (text: string) => palette.brightMagenta(text),
  danger: (text: string) => palette.brightRed(text),
};

// Raised background for the fixed top status bar (mode + model + context).
export const STATUS_BAR_BG = palette.bgSurface;

export const MODE_BG_COLORS: Record<
  "plan" | "build" | "review" | "explore" | "danger",
  (text: string) => string
> = {
  plan: palette.bgBlue,
  build: palette.bgAccent,
  review: palette.bgGreen,
  explore: palette.bgMagenta,
  danger: palette.bgRed,
};
