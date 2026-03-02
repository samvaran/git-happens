/**
 * Startup setup check: gh installed and authenticated, which AI CLIs are available.
 * Optionally can run a quick "working" check (e.g. minimal prompt) per AI — currently we only check availability (binary runs).
 */

import type { AiBackend } from "./ai.ts";
import {
  SGR,
  FOOTER,
  renderTutorialHeader,
  buildCardLines,
  cardWidth,
} from "./tutorial_ui.ts";
import { VERSION } from "./version.ts";

const PACKAGE_LICENSE = "MIT";

const AI_BACKENDS: AiBackend[] = ["claude", "gemini", "cursor", "codex"];

const AI_LABELS: Record<AiBackend, string> = {
  claude: "Claude",
  gemini: "Gemini",
  cursor: "Cursor",
  codex: "OpenAI Codex",
};

const AI_SUBTITLES: Record<AiBackend, string> = {
  claude: "Anthropic's assistant CLI",
  gemini: "Google's Gemini CLI",
  cursor: "Cursor IDE's built-in CLI",
  codex: "OpenAI Codex CLI",
};

const CHECK_TIMEOUT_MS = 4000;

export interface GhCheckResult {
  ok: boolean;
  /** When ok is false: 'not_installed' | 'not_authenticated' */
  error?: "not_installed" | "not_authenticated";
  message?: string;
}

export interface AiCheckResult {
  available: boolean;
  /** If we ran a quick auth/working check (future) */
  working?: boolean;
}

export interface SetupResult {
  gh: GhCheckResult;
  ai: Record<AiBackend, AiCheckResult>;
}

async function runWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ success: boolean; code?: number; stderr?: string }> {
  try {
    const proc = new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    let out: Deno.CommandOutput;
    try {
      out = await proc.output();
    } catch {
      out = {
        success: false,
        code: -1,
        signal: null,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
      } as Deno.CommandOutput;
    }
    clearTimeout(t);
    const stderr = new TextDecoder().decode(out.stderr);
    return {
      success: !timedOut && out.success,
      code: out.code,
      stderr: stderr || undefined,
    };
  } catch {
    return { success: false };
  }
}

/** Check if gh is installed and authenticated. */
export async function checkGh(): Promise<GhCheckResult> {
  const versionResult = await runWithTimeout("gh", ["--version"], 3000);
  if (!versionResult.success || versionResult.code === 127) {
    return {
      ok: false,
      error: "not_installed",
      message:
        "GitHub CLI (gh) is not installed or not in PATH.\n\n  Install: https://cli.github.com\n  Then run: gh auth login",
    };
  }
  const authResult = await runWithTimeout("gh", ["auth", "status"], 5000);
  if (!authResult.success) {
    return {
      ok: false,
      error: "not_authenticated",
      message:
        "gh is installed but you are not logged in.\n\n  Run: gh auth login",
    };
  }
  return { ok: true };
}

/** Check if an AI CLI binary is available (runs --version or --help). */
export async function checkAiCli(backend: AiBackend): Promise<AiCheckResult> {
  const result = await runWithTimeout(backend, ["--version"], CHECK_TIMEOUT_MS);
  if (result.success) return { available: true };
  if (result.code === 127) return { available: false };
  const helpResult = await runWithTimeout(backend, ["--help"], CHECK_TIMEOUT_MS);
  return { available: helpResult.success };
}

/** Run all setup checks in parallel. */
export async function runSetupCheck(): Promise<SetupResult> {
  const [gh, ...aiResults] = await Promise.all([
    checkGh(),
    ...AI_BACKENDS.map((b) => checkAiCli(b)),
  ]);
  const ai: Record<AiBackend, AiCheckResult> = {
    claude: aiResults[0],
    gemini: aiResults[1],
    cursor: aiResults[2],
    codex: aiResults[3],
  };
  return { gh, ai };
}

export function getAvailableBackends(result: SetupResult): AiBackend[] {
  return AI_BACKENDS.filter((b) => result.ai[b].available);
}

const SGR_SETUP = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m", bold: "\x1b[1m" };

/** Print setup status (gh + each AI) to the console. */
export function printSetupStatus(result: SetupResult): void {
  const ghTick = result.gh.ok ? SGR_SETUP.green + "✓" + SGR_SETUP.reset : SGR_SETUP.red + "✗" + SGR_SETUP.reset;
  const ghNote = !result.gh.ok && result.gh.error
    ? "  " + SGR_SETUP.dim + (result.gh.error === "not_installed" ? "not installed" : "not logged in") + SGR_SETUP.reset
    : "";
  console.log(SGR_SETUP.bold + "Setup" + SGR_SETUP.reset);
  console.log("  gh (GitHub CLI):  " + ghTick + ghNote);
  for (const b of AI_BACKENDS) {
    const a = result.ai[b].available ? SGR_SETUP.green + "✓" + SGR_SETUP.reset : SGR_SETUP.dim + "—" + SGR_SETUP.reset;
    console.log("  " + AI_LABELS[b].padEnd(14) + " " + a);
  }
  console.log("");
}

/** Print instructions when gh is missing or not authenticated, then exit. */
export function printGhInstructionsAndExit(result: GhCheckResult): void {
  console.error("");
  console.error(SGR_SETUP.bold + "GitHub CLI (gh) is required." + SGR_SETUP.reset);
  console.error("");
  console.error(result.message ?? "Run: gh auth login");
  console.error("");
  Deno.exit(1);
}

/** Print instructions when no AI CLI is available, then exit. */
export function printAiInstructionsAndExit(): void {
  console.error("");
  console.error(SGR_SETUP.bold + "No AI CLI found." + SGR_SETUP.reset);
  console.error("");
  console.error("Install at least one and ensure it's in your PATH:");
  console.error("  Claude:    https://claude.ai/install  or  brew install --cask claude-code");
  console.error("  Gemini:    https://github.com/google-gemini/gemini-cli");
  console.error("  Cursor:    https://cursor.com (includes CLI)");
  console.error("  Codex:    npm install -g @openai/codex  or  brew install --cask codex");
  console.error("");
  Deno.exit(1);
}

/** Choose which AI backend to use. If only one available, returns it. If multiple and TTY, shows tutorial-style selector. */
export async function selectAiBackend(
  available: AiBackend[],
  preferred?: AiBackend
): Promise<AiBackend> {
  if (available.length === 0) return "claude";
  if (available.length === 1) return available[0];
  if (!Deno.stdin.isTerminal()) return preferred && available.includes(preferred) ? preferred : available[0];

  let selectedIndex = Math.max(
    0,
    preferred ? available.indexOf(preferred) : 0
  );
  if (selectedIndex < 0) selectedIndex = 0;

  function parseKey(buf: Uint8Array): "up" | "down" | "enter" | "escape" | null {
    if (buf.length === 0) return null;
    if (buf[0] === 0x1b && buf.length >= 3 && buf[1] === 0x5b) {
      if (buf[2] === 0x41) return "up";
      if (buf[2] === 0x42) return "down";
    }
    if (buf[0] === 0x1b && buf.length === 1) return "escape";
    if (buf[0] === 0x0d || buf[0] === 0x0a) return "enter";
    return null;
  }

  async function readKey(): Promise<"up" | "down" | "enter" | "escape"> {
    const buf = new Uint8Array(16);
    const n = await Deno.stdin.read(buf);
    if (n === null) return "escape";
    return parseKey(buf.subarray(0, n)) ?? "escape";
  }

  const render = () => {
    Deno.stdout.writeSync(new TextEncoder().encode(SGR.clear));
    const { columns } = Deno.consoleSize();
    const packageInfo = `git-happens v${VERSION}  ·  ${PACKAGE_LICENSE}`;
    renderTutorialHeader(columns, {
      step: "Step 1 of 2",
      tagline: "Choose which AI will power your reviews",
      extra: [packageInfo, "Select your AI backend below"],
    });

    const width = cardWidth(columns);
    const margin = " ".repeat(Math.max(0, (columns - width) >> 1));
    for (let i = 0; i < available.length; i++) {
      const b = available[i];
      const selected = i === selectedIndex;
      const lines = buildCardLines(AI_LABELS[b], AI_SUBTITLES[b], width, selected);
      const style = selected ? SGR.reverse : "";
      for (const line of lines) {
        console.log(margin + style + line + SGR.reset);
      }
      console.log("");
    }
    console.log(SGR.dim + FOOTER + SGR.reset);
  };

  Deno.stdin.setRaw(true);
  try {
    for (;;) {
      render();
      const key = await readKey();
      if (key === "enter") return available[selectedIndex];
      if (key === "escape") return available[0];
      if (key === "up") selectedIndex = (selectedIndex - 1 + available.length) % available.length;
      if (key === "down") selectedIndex = (selectedIndex + 1) % available.length;
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
}
