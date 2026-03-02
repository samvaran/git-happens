import type { PRListItem } from "./types.ts";

const SGR = {
  clear: "\x1b[2J\x1b[H",
  reverse: "\x1b[7m",
  reset: "\x1b[0m",
};

type Key =
  | { type: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { type: "backspace" }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "char"; char: string };

function parseKey(buf: Uint8Array): Key | null {
  if (buf.length === 0) return null;
  if (buf[0] === 0x1b && buf.length >= 3 && buf[1] === 0x5b) {
    const dir = buf[2] === 0x41
      ? "up"
      : buf[2] === 0x42
      ? "down"
      : buf[2] === 0x43
      ? "right"
      : buf[2] === 0x44
      ? "left"
      : null;
    if (dir) return { type: "arrow", dir };
  }
  if (buf[0] === 0x1b && buf.length === 1) return { type: "escape" };
  if (buf[0] === 0x0d || buf[0] === 0x0a) return { type: "enter" };
  if (buf[0] === 0x7f || buf[0] === 0x08) return { type: "backspace" };
  const s = new TextDecoder().decode(buf);
  if (s.length === 1 && /[a-zA-Z0-9\s.-_]/.test(s)) {
    return { type: "char", char: s };
  }
  return null;
}

async function readKey(): Promise<Key> {
  const buf = new Uint8Array(32);
  const n = await Deno.stdin.read(buf);
  if (n === null) return { type: "escape" };
  const key = parseKey(buf.subarray(0, n));
  if (key) return key;
  return { type: "escape" };
}

const SECTION_LABELS: Record<PRListItem["section"] & string, string> = {
  assigned: "Assigned to you",
  review_requested: "Review requested",
  open_other: "Open (not assigned to you)",
  my_prs: "Your PRs",
  fixes_has_feedback: "Has review feedback (waiting for you)",
  fixes_other: "Your other open PRs",
};

function wrapLines(text: string, width: number): string[] {
  if (width < 4) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= width) {
      out.push(rest);
      break;
    }
    const chunk = rest.slice(0, width);
    const lastSpace = chunk.lastIndexOf(" ");
    const breakAt = lastSpace > width >> 1 ? lastSpace : width;
    out.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  return out;
}

const SIZE_WIDTH = 14;
const AUTHOR_WIDTH = 18;
/** Spaces between columns (size | author | title). */
const COL_GAP = 3;

function sizeStr(p: PRListItem): string {
  if (p.additions != null && p.deletions != null) {
    return `+${p.additions} / -${p.deletions}`;
  }
  return "—";
}

type VisualLine =
  | { type: "repo"; text: string }
  | { type: "header"; text: string }
  | { type: "blank" }
  | { type: "pr"; text: string; prIndex: number };

function buildVisualLines(
  list: PRListItem[],
  columns: number,
): { lines: VisualLine[]; prFirstLine: number[] } {
  const lines: VisualLine[] = [];
  const prFirstLine: number[] = [];
  let lastRepo: string | undefined;
  let lastSection: PRListItem["section"] = undefined;
  const titleWidth = Math.max(
    10,
    columns - 2 - SIZE_WIDTH - COL_GAP - AUTHOR_WIDTH - COL_GAP,
  );
  const colSpacer = " ".repeat(COL_GAP);
  const continuationIndent = SIZE_WIDTH + COL_GAP + AUTHOR_WIDTH + COL_GAP;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const repo = p.repository?.nameWithOwner ?? "?";
    if (repo !== lastRepo) {
      lastRepo = repo;
      lastSection = undefined;
      lines.push({ type: "blank" });
      lines.push({ type: "repo", text: `=== ${repo} ===` });
    }
    if (p.section !== lastSection && p.section) {
      lastSection = p.section;
      const label = SECTION_LABELS[p.section] ?? p.section;
      lines.push({ type: "blank" });
      lines.push({ type: "header", text: `--- ${label} ---` });
    }
    prFirstLine.push(lines.length);
    const size = sizeStr(p).padEnd(SIZE_WIDTH);
    const author = (p.author.login ?? "?").slice(0, AUTHOR_WIDTH).padEnd(
      AUTHOR_WIDTH,
    );
    const titleDisplay = p.userHasPendingReview
      ? `${p.title} [draft]`
      : p.title;
    const titleLines = wrapLines(titleDisplay, titleWidth);
    for (let j = 0; j < titleLines.length; j++) {
      const title = j === 0
        ? titleLines[j]
        : " ".repeat(continuationIndent) + titleLines[j];
      lines.push({
        type: "pr",
        text: size + colSpacer + author + colSpacer + title,
        prIndex: i,
      });
    }
  }
  return { lines, prFirstLine };
}

/**
 * Print a PR list as a formatted table: grouped by repo, sorted by size within repo,
 * columns size | author | title, with blank lines between sections (same style as picker).
 */
export function printPrTable(prs: PRListItem[]): void {
  if (prs.length === 0) return;
  const byRepo = new Map<string, PRListItem[]>();
  for (const p of prs) {
    const repo = p.repository?.nameWithOwner ?? "?";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(p);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => {
      const sa = (a.additions ?? 0) + (a.deletions ?? 0);
      const sb = (b.additions ?? 0) + (b.deletions ?? 0);
      return sb - sa;
    });
  }
  const repoOrder = [...byRepo.keys()].sort();
  const columns = Deno.consoleSize().columns;
  const titleWidth = Math.max(
    10,
    columns - 2 - SIZE_WIDTH - COL_GAP - AUTHOR_WIDTH - COL_GAP,
  );
  const colSpacer = " ".repeat(COL_GAP);
  const continuationIndent = SIZE_WIDTH + COL_GAP + AUTHOR_WIDTH + COL_GAP;

  for (const repo of repoOrder) {
    const list = byRepo.get(repo)!;
    console.log("");
    console.log(`=== ${repo} ===`);
    for (const p of list) {
      const size = sizeStr(p).padEnd(SIZE_WIDTH);
      const author = (p.author.login ?? "?").slice(0, AUTHOR_WIDTH).padEnd(
        AUTHOR_WIDTH,
      );
      const titleDisplay = p.userHasPendingReview
        ? `${p.title} [draft]`
        : p.title;
      const titleLines = wrapLines(titleDisplay, titleWidth);
      for (let j = 0; j < titleLines.length; j++) {
        const title = j === 0
          ? titleLines[j]
          : " ".repeat(continuationIndent) + titleLines[j];
        console.log(size + colSpacer + author + colSpacer + title);
      }
    }
  }
}

/** Options for the PR picker (e.g. fixes mode: only my PRs with different sections). */
export interface PickPrOptions {
  /** When true, sections are fixes_has_feedback first, then fixes_other. */
  fixesMode?: boolean;
}

/** Pick one PR from a list: grouped by repo, one set of section tables per repo, columns size | author | title. */
export async function pickPr(
  prs: PRListItem[],
  opts: PickPrOptions = {},
): Promise<PRListItem | null> {
  if (prs.length === 0) return null;
  const { fixesMode = false } = opts;
  const sectionOrder = (s: PRListItem["section"]) => {
    if (fixesMode) {
      return s === "fixes_has_feedback" ? 0 : s === "fixes_other" ? 1 : 2;
    }
    return s === "assigned"
      ? 0
      : s === "review_requested"
      ? 1
      : s === "open_other"
      ? 2
      : 3;
  };
  const byRepo = new Map<string, PRListItem[]>();
  for (const p of prs) {
    const repo = p.repository?.nameWithOwner ?? "?";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(p);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => {
      const so = sectionOrder(a.section) - sectionOrder(b.section);
      if (so !== 0) return so;
      const sa = (a.additions ?? 0) + (a.deletions ?? 0);
      const sb = (b.additions ?? 0) + (b.deletions ?? 0);
      return sb - sa;
    });
  }
  const repoOrder = [...byRepo.keys()].sort();
  const sorted: PRListItem[] = [];
  for (const repo of repoOrder) {
    sorted.push(...byRepo.get(repo)!);
  }

  let filter = "";
  let selectedIndex = 0;
  const filtered = () => {
    const q = filter.toLowerCase().trim();
    if (!q) return sorted;
    return sorted.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        String(p.number).includes(q) ||
        p.author.login.toLowerCase().includes(q) ||
        p.repository?.nameWithOwner?.toLowerCase().includes(q),
    );
  };

  const { columns, rows } = Deno.consoleSize();
  const bodyRows = Math.max(1, rows - 2);

  const render = () => {
    const list = filtered();
    if (list.length > 0) {
      selectedIndex = Math.min(selectedIndex, list.length - 1);
    }
    const { lines, prFirstLine } = buildVisualLines(list, columns);
    const totalLines = lines.length;
    const firstLineOfSelected = prFirstLine[selectedIndex] ?? 0;
    const startRow = Math.min(
      Math.max(0, firstLineOfSelected - Math.floor(bodyRows / 2)),
      Math.max(0, totalLines - bodyRows),
    );
    const endRow = Math.min(startRow + bodyRows, totalLines);

    Deno.stdout.writeSync(new TextEncoder().encode(SGR.clear));
    for (let i = startRow; i < endRow; i++) {
      const line = lines[i];
      if (line.type === "blank") {
        console.log("");
      } else if (line.type === "repo" || line.type === "header") {
        console.log(line.text);
      } else {
        const isSelected = line.prIndex === selectedIndex;
        console.log(
          isSelected ? SGR.reverse + line.text + SGR.reset : line.text,
        );
      }
    }
    console.log("");
    console.log("Filter: " + filter + "_");
    console.log("↑↓ move  Enter select  Esc cancel  Type to filter");
  };

  Deno.stdin.setRaw(true);
  try {
    for (;;) {
      const list = filtered();
      if (list.length > 0) {
        selectedIndex = Math.min(selectedIndex, list.length - 1);
      }
      render();

      const key = await readKey();
      if (key.type === "enter") {
        if (list.length > 0) return list[selectedIndex] ?? null;
        continue;
      }
      if (key.type === "escape") return null;
      if (key.type === "backspace") {
        filter = filter.slice(0, -1);
        selectedIndex = 0;
        continue;
      }
      if (key.type === "char") {
        filter += key.char;
        selectedIndex = 0;
        continue;
      }
      if (key.type === "arrow") {
        const n = list.length;
        if (n === 0) continue;
        if (key.dir === "up") selectedIndex = (selectedIndex - 1 + n) % n;
        else if (key.dir === "down") selectedIndex = (selectedIndex + 1) % n;
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
}
