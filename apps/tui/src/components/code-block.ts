import { palette } from "../palette.js";
import { highlight, supportsLanguage } from "cli-highlight";

// Syntax palette used by both `renderCodeBlock` (this file) and `renderDiff`
// (in `diff-view.ts`). Centralized so the two stay visually consistent;
// the colours themselves come from `palette.syntax` (Dracula by default,
// the active theme on Omarchy).
export const diffTheme = {
  keyword: palette.syntax.keyword,
  built_in: palette.syntax.builtin,
  type: palette.syntax.builtin,
  literal: palette.syntax.literal,
  number: palette.syntax.literal,
  regexp: palette.syntax.string,
  string: palette.syntax.string,
  comment: palette.syntax.comment,
  function: palette.syntax.function,
  class: palette.syntax.builtin,
  attr: palette.syntax.attr,
  tag: palette.syntax.keyword,
  name: palette.syntax.keyword,
  meta: palette.syntax.attr,
  default: palette.syntax.default,
};

/**
 * Render a markdown code block with Dracula syntax highlighting, indented
 * two columns so it reads as a block against the surrounding prose. No
 * line-number gutter: fences carry commit messages and config snippets as
 * often as code, and numbering those was noise.
 *
 * Lines are emitted as-is (no width truncation) so the surrounding
 * WidthBounded wrapper clips/pads consistently.
 */
export function renderCodeBlock(code: string, lang?: string): string[] {
  const useLang = lang && supportsLanguage(lang) ? lang : undefined;

  return code.split("\n").map((rawLine) => {
    let highlighted: string;
    if (useLang && rawLine.trim().length > 0) {
      try {
        highlighted = highlight(rawLine, { language: useLang, theme: diffTheme });
      } catch {
        highlighted = rawLine;
      }
    } else {
      highlighted = rawLine;
    }

    return `  ${highlighted}`;
  });
}