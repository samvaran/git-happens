/**
 * Shared tutorial-style UI: header, step indicator, card layout, footer.
 * Keeps the AI selector and mode selector feeling like one cohesive flow.
 */

export const APP_TITLE = "Git Happens";

export const SGR = {
  clear: "\x1b[2J\x1b[H",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",
  reset: "\x1b[0m",
};

export const FOOTER = "  ↑↓ Select   Enter confirm   Esc cancel";

function center(text: string, columns: number): string {
  return " ".repeat(Math.max(0, (columns - text.length) >> 1)) + text;
}

/** Print the shared tutorial header: app title, optional step (e.g. "Step 1 of 2"), tagline, optional extra dim lines. */
export function renderTutorialHeader(
  columns: number,
  options: {
    step?: string;
    tagline?: string;
    extra?: string[];
  } = {}
): void {
  const { step, tagline, extra = [] } = options;
  const lineLen = Math.min(columns, 44);
  const sep = "─".repeat(lineLen);
  console.log("");
  console.log(center(SGR.bold + APP_TITLE + SGR.reset, columns));
  if (step) console.log(center(SGR.dim + step + SGR.reset, columns));
  if (tagline) console.log(center(SGR.dim + tagline + SGR.reset, columns));
  for (const line of extra) console.log(center(SGR.dim + line + SGR.reset, columns));
  console.log(center(SGR.dim + sep + SGR.reset, columns));
  console.log("");
}

function wrapText(text: string, maxLen: number): string[] {
  if (maxLen < 4) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      out.push(rest);
      break;
    }
    const chunk = rest.slice(0, maxLen);
    const lastSpace = chunk.lastIndexOf(" ");
    const breakAt = lastSpace > maxLen >> 1 ? lastSpace : maxLen;
    out.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  return out;
}

/** Build card lines (box with title + optional subtitle). selected = double border + use for reverse video. */
export function buildCardLines(
  title: string,
  subtitle: string,
  width: number,
  selected: boolean
): string[] {
  const inner = Math.max(20, width - 4);
  const contentWidth = inner - 4;
  const [tl, tr, bl, br, h, v] = selected
    ? ["╔", "╗", "╚", "╝", "═", "║"]
    : ["┌", "┐", "└", "┘", "─", "│"];
  const top = tl + h.repeat(inner) + tr;
  const bot = bl + h.repeat(inner) + br;
  const titleLine = v + "  " + title.padEnd(contentWidth) + "  " + v;
  const subtitleLines = wrapText(subtitle, contentWidth);
  const subLines = subtitleLines.map(
    (line) => v + "  " + line.padEnd(contentWidth) + "  " + v
  );
  return [top, titleLine, ...subLines, bot];
}

/** Card width for current terminal. */
export function cardWidth(columns: number): number {
  return Math.min(64, Math.max(48, columns - 4));
}
