import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";

// Dracula palette used by both `renderCodeBlock` (this file) and `renderDiff`
// (in `diff-view.ts`). Centralized so the two stay visually consistent.
export const diffTheme = {
  keyword: chalk.hex("#ff79c6"),      // Dracula pink/magenta
  built_in: chalk.hex("#8be9fd"),     // Dracula cyan
  type: chalk.hex("#8be9fd"),         // Dracula cyan
  literal: chalk.hex("#bd93f9"),      // Dracula purple
  number: chalk.hex("#bd93f9"),       // Dracula purple
  regexp: chalk.hex("#f1fa8c"),       // Dracula yellow
  string: chalk.hex("#f1fa8c"),       // Dracula yellow
  comment: chalk.hex("#6272a4"),      // Dracula gray/blue comment
  function: chalk.hex("#50fa7b"),     // Dracula green
  class: chalk.hex("#8be9fd"),        // Dracula cyan
  attr: chalk.hex("#ffb86c"),         // Dracula orange
  tag: chalk.hex("#ff79c6"),          // Dracula pink
  name: chalk.hex("#ff79c6"),         // Dracula pink
  meta: chalk.hex("#ffb86c"),         // Dracula orange
  default: chalk.hex("#f8f8f2")       // Dracula white
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