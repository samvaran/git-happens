/**
 * Large, visually prominent selector for app mode: AI PR Review vs AI PR Fixes.
 * Uses shared tutorial UI (Step 2 of 2) for a cohesive flow with the AI selector.
 */

import type { AiBackend } from "./ai.ts";
import { VERSION } from "./version.ts";
import {
  SGR,
  FOOTER,
  renderTutorialHeader,
  buildCardLines,
  cardWidth,
} from "./tutorial_ui.ts";

export type AppMode = "review" | "fixes";

const PACKAGE_LICENSE = "MIT";

const AI_BACKEND_LABEL: Record<AiBackend, string> = {
  claude: "Claude",
  gemini: "Gemini",
  cursor: "Cursor",
  codex: "OpenAI Codex",
};

type Key =
  | { type: "arrow"; dir: "up" | "down" }
  | { type: "enter" }
  | { type: "escape" };

function parseKey(buf: Uint8Array): Key | null {
  if (buf.length === 0) return null;
  if (buf[0] === 0x1b && buf.length >= 3 && buf[1] === 0x5b) {
    const dir = buf[2] === 0x41 ? "up" : buf[2] === 0x42 ? "down" : null;
    if (dir) return { type: "arrow", dir };
  }
  if (buf[0] === 0x1b && buf.length === 1) return { type: "escape" };
  if (buf[0] === 0x0d || buf[0] === 0x0a) return { type: "enter" };
  return null;
}

async function readKey(): Promise<Key> {
  const buf = new Uint8Array(16);
  const n = await Deno.stdin.read(buf);
  if (n === null) return { type: "escape" };
  const key = parseKey(buf.subarray(0, n));
  return key ?? { type: "escape" };
}

const MODES: { mode: AppMode; title: string; subtitle: string }[] = [
  {
    mode: "review",
    title: "AI PR Review",
    subtitle: "Get AI to review a PR and post feedback to GitHub",
  },
  {
    mode: "fixes",
    title: "AI PR Fixes",
    subtitle: "Fix a PR based on review feedback",
  },
];

/** Options for the mode selector (e.g. current AI backend to display). */
export interface SelectModeOptions {
  /** Current AI backend; shown as "AI: Claude" and how to switch. */
  backend?: AiBackend;
  /** Step label when part of the tutorial flow (e.g. "Step 2 of 2" or "Step 1 of 1" if AI was skipped). */
  stepLabel?: string;
}

/** Show the mode selector; returns selected mode or null on cancel. */
export async function selectMode(opts: SelectModeOptions = {}): Promise<AppMode | null> {
  const { backend = "claude", stepLabel = "Step 2 of 2" } = opts;
  const { columns } = Deno.consoleSize();
  const width = cardWidth(columns);
  let selectedIndex = 0;

  const packageInfo = `git-happens v${VERSION}  ·  ${PACKAGE_LICENSE}`;
  const aiInfo = `AI: ${AI_BACKEND_LABEL[backend]}  ·  restart to choose another`;

  const render = () => {
    const enc = new TextEncoder();
    Deno.stdout.writeSync(enc.encode(SGR.clear));

    renderTutorialHeader(columns, {
      step: stepLabel,
      tagline: "What do you want to do?",
      extra: [packageInfo, aiInfo],
    });

    const margin = " ".repeat(Math.max(0, (columns - width) >> 1));
    for (let i = 0; i < MODES.length; i++) {
      const selected = i === selectedIndex;
      const lines = buildCardLines(MODES[i].title, MODES[i].subtitle, width, selected);
      const style = selected ? SGR.reverse : "";
      for (const line of lines) {
        console.log(margin + style + line + SGR.reset);
      }
      console.log("");
    }
    console.log(SGR.dim + FOOTER + SGR.reset);
  };

  if (!Deno.stdin.isTerminal()) {
    return "review";
  }

  Deno.stdin.setRaw(true);
  try {
    for (;;) {
      render();
      const key = await readKey();
      if (key.type === "enter") {
        return MODES[selectedIndex].mode;
      }
      if (key.type === "escape") {
        return null;
      }
      if (key.type === "arrow") {
        if (key.dir === "up") {
          selectedIndex = (selectedIndex - 1 + MODES.length) % MODES.length;
        } else {
          selectedIndex = (selectedIndex + 1) % MODES.length;
        }
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
}
