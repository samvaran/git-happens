import type {
  FixesResult,
  PrReview,
  PrReviewComment,
  ReviewResult,
} from "./types.ts";

const DEFAULT_PROMPT =
  `You're doing code review for a teammate. Your review gets posted to GitHub. Sound like a direct, thoughtful human — no corporate speak, no filler, no "as an AI". Every comment should earn its place.

## Your process

1. Read the diff and PR description. Get what they're doing and why.
2. Look for real issues: wrong approach, missing error handling, security, race conditions, abstractions that'll bite later.
3. Call out bugs, logic errors, and meaningful improvements. Skip the rest.

## Review body (the main comment)

Do **not** summarize the PR. The author already knows what they did. Your job is to briefly summarize **your review** — the takeaway. A few bullets or a short paragraph: what they should do next, what to watch out for, or the one or two themes from your feedback. Don't rehash each inline comment; point to the details in the thread. If it's an approval and there's nothing to add, keep it very short or a single line. Don't restate the verdict (approve / request changes) — the UI already shows it.

If they did something particularly clever or creative, one or two encouraging words are fine. No more. No generic "Great work!".

## Inline comments

Only add comments that are purposeful. No fluff. No "consider adding tests". No suggestions that are purely a matter of opinion — only nits that are actually useful (e.g. a real gotcha, not "I'd name this differently"). Use plain language; avoid jargon when a simple word works.

Each comment: what's wrong and why it matters, in 1–3 sentences. Suggest a fix only when it's non-obvious. Code snippets when they save time. If you're unsure, say so ("might be wrong but this could panic if...").

Classify at the start of each comment, lowercase: \`blocker:\` (must fix before merge), \`suggestion:\` (worth considering, safe to merge without), or \`nit:\` (only if useful — not "matter of opinion" nits; keep to one or two).

**Approvals:** You usually don't need inline comments. Only add them if they're genuinely useful or "things to keep in mind before merging."

## Structured output

Return a single JSON object, nothing else:

{
  "summary": "your review body (takeaway, not PR summary; no verdict restated)",
  "verdict": "approve" | "request_changes" | "comment",
  "inline_comments": [
    {
      "path": "src/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "blocker: this could throw if..."
    }
  ]
}

- \`side\`: "RIGHT" for a line in the new (head) version, "LEFT" for the old (base).
- \`verdict\`: "request_changes" if any blockers; "approve" if it's good (with or without suggestions); "comment" if suggestions only, nothing blocking.
- Output only the JSON.`;

/** Build the prompt sent to the AI (PR context + diff). */
export function buildPrompt(
  diff: string,
  prTitle?: string,
  prBody?: string,
): string {
  const header = [
    prTitle && `# PR: ${prTitle}`,
    prBody && `## Description\n${prBody.slice(0, 2000)}`,
    "## Diff\n",
  ]
    .filter(Boolean)
    .join("\n");
  return `${DEFAULT_PROMPT}\n\n---\n\n${header}\n\`\`\`diff\n${diff}\n\`\`\``;
}

export type AiBackend = "claude" | "gemini" | "cursor" | "codex";

/** Token usage when the CLI reports it (e.g. on stderr or in JSON envelope). */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Raw line(s) we parsed from (for display). */
  raw?: string;
}

/**
 * Try to extract token/usage info from CLI stderr.
 * CLIs don't standardize this; we look for common patterns (JSON usage, "X tokens", etc.).
 */
export function parseTokenUsage(stderr: string): TokenUsage | null {
  if (!stderr || !stderr.trim()) return null;
  const s = stderr.trim();

  // JSON-style: "input_tokens": 123, "output_tokens": 456 (Anthropic-style)
  const anthropic = s.match(
    /"input_tokens"\s*:\s*(\d+).*?"output_tokens"\s*:\s*(\d+)/s,
  );
  if (anthropic) {
    const input = parseInt(anthropic[1], 10);
    const output = parseInt(anthropic[2], 10);
    if (!isNaN(input) && !isNaN(output)) {
      return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      };
    }
  }

  // JSON-style: "prompt_tokens": 123, "completion_tokens": 456 (OpenAI-style)
  const openai = s.match(
    /"prompt_tokens"\s*:\s*(\d+).*?"completion_tokens"\s*:\s*(\d+)/s,
  );
  if (openai) {
    const prompt = parseInt(openai[1], 10);
    const completion = parseInt(openai[2], 10);
    if (!isNaN(prompt) && !isNaN(completion)) {
      return {
        input_tokens: prompt,
        output_tokens: completion,
        total_tokens: prompt + completion,
      };
    }
  }

  // "usage": { "input_tokens": N, "output_tokens": M }
  const usageBlock = s.match(
    /"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)/s,
  ) ??
    s.match(
      /"usage"\s*:\s*\{[^}]*"output_tokens"\s*:\s*(\d+)[^}]*"input_tokens"\s*:\s*(\d+)/s,
    );
  if (usageBlock) {
    const a = parseInt(usageBlock[1], 10);
    const b = parseInt(usageBlock[2], 10);
    if (!isNaN(a) && !isNaN(b)) {
      return { input_tokens: a, output_tokens: b, total_tokens: a + b };
    }
  }

  // Plain text: "1234 input / 567 output" or "1234 tokens in, 567 out"
  const inOut = s.match(
    /(\d+)\s*(?:input|prompt|in)[\s,/]*(\d+)\s*(?:output|completion|out)/i,
  ) ??
    s.match(/(\d+)\s*\/\s*(\d+)\s*tokens?/i);
  if (inOut) {
    const inN = parseInt(inOut[1], 10);
    const outN = parseInt(inOut[2], 10);
    if (!isNaN(inN) && !isNaN(outN)) {
      return {
        input_tokens: inN,
        output_tokens: outN,
        total_tokens: inN + outN,
      };
    }
  }

  // Single total: "Used 12345 tokens" or "tokens: 12345"
  const total = s.match(/(?:used|tokens?)\s*:?\s*(\d+)/i) ??
    s.match(/(\d+)\s*tokens?\s*(?:used|total)?/i);
  if (total) {
    const n = parseInt(total[1], 10);
    if (!isNaN(n) && n < 1e7) {
      return { total_tokens: n, raw: total[0] };
    }
  }

  return null;
}

function formatTokenUsage(u: TokenUsage): string {
  const parts: string[] = [];
  if (u.input_tokens != null) {
    parts.push(`${u.input_tokens.toLocaleString()} in`);
  }
  if (u.output_tokens != null) {
    parts.push(`${u.output_tokens.toLocaleString()} out`);
  }
  if (parts.length) return parts.join(" / ");
  if (u.total_tokens != null) return `${u.total_tokens.toLocaleString()} total`;
  if (u.raw) return u.raw.slice(0, 60);
  return "";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;

/**
 * Run the AI CLI under a PTY (via Unix `script`) so it sees a TTY and may stream output.
 * Streams stdout to the terminal while buffering for parsing. Falls back to spinner if PTY unavailable.
 */
async function runAiCliWithPty(
  cli: string,
  promptBytes: Uint8Array,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const os = Deno.build.os;
  if (os === "windows") {
    return runAiCliWithSpinner(cli, promptBytes);
  }

  // script runs the child in a PTY so it gets line buffering. Linux: script -q -c "cli" /dev/null; macOS: script -q /dev/null cli
  const scriptArgs = os === "darwin"
    ? ["-q", "/dev/null", cli]
    : ["-q", "-c", cli, "/dev/null"];

  const cmd = new Deno.Command("script", {
    args: scriptArgs,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  let proc: Deno.ChildProcess;
  try {
    proc = cmd.spawn();
  } catch {
    return runAiCliWithSpinner(cli, promptBytes);
  }

  const writer = proc.stdin.getWriter();
  await writer.write(promptBytes);
  await writer.close();

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const encoder = new TextEncoder();

  const readStdout = async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const text = stdoutDecoder.decode(value, { stream: true });
          stdoutChunks.push(text);
          Deno.stdout.writeSync(encoder.encode(text));
        }
      }
      stdoutChunks.push(stdoutDecoder.decode());
    } finally {
      reader.releaseLock();
    }
  };

  const readStderr = async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const text = stderrDecoder.decode(value, { stream: true });
          stderrChunks.push(text);
          Deno.stderr.writeSync(encoder.encode(text));
        }
      }
      stderrChunks.push(stderrDecoder.decode());
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([readStdout(), readStderr()]);
  const status = await proc.status;
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    success: status.success,
  };
}

/** Run the AI CLI with pipes only (no PTY). Shows a loading spinner while waiting. */
async function runAiCliWithSpinner(
  cli: string,
  promptBytes: Uint8Array,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command(cli, {
    args: [],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(promptBytes);
  await writer.close();

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  let spinnerRunning = true;
  let frameIndex = 0;
  const label = `Waiting for ${cli}...`;
  const encoder = new TextEncoder();

  const spinnerLoop = async () => {
    while (spinnerRunning) {
      const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
      frameIndex += 1;
      Deno.stdout.writeSync(encoder.encode(`\r  ${frame} ${label}   `));
      await new Promise((r) => setTimeout(r, SPINNER_MS));
    }
  };

  const readStdout = async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const text = stdoutDecoder.decode(value, { stream: true });
          stdoutChunks.push(text);
        }
      }
      stdoutChunks.push(stdoutDecoder.decode());
    } finally {
      reader.releaseLock();
    }
  };

  const readStderr = async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          const text = stderrDecoder.decode(value, { stream: true });
          stderrChunks.push(text);
        }
      }
      stderrChunks.push(stderrDecoder.decode());
    } finally {
      reader.releaseLock();
    }
  };

  void spinnerLoop();
  await Promise.all([readStdout(), readStderr()]);
  spinnerRunning = false;
  const status = await proc.status;
  Deno.stdout.writeSync(
    encoder.encode("\r" + " ".repeat(label.length + 6) + "\r"),
  );
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    success: status.success,
  };
}

/**
 * Run the configured AI CLI with the prompt and return parsed ReviewResult.
 *
 * **How it works (CLI as API):** We don't call an HTTP API. We spawn the AI CLI (e.g. `claude`)
 * as a subprocess, write the full prompt to its stdin, and read the model's reply from stdout.
 * Stdout is streamed to the terminal so you see the response as it's generated.
 * The CLI handles auth, model choice, and network; we just send text in and get text back.
 * The prompt instructs the model to return a single JSON object so we can parse it and post
 * the review to GitHub.
 *
 * backend: chosen at startup (setup check + AI selector).
 */
export async function runReview(
  prompt: string,
  backend: AiBackend = "claude",
  log = (msg: string) => console.log(msg),
): Promise<ReviewResult> {
  const cli = backend;

  try {
    log(
      `  → Sending prompt (${
        (new TextEncoder().encode(prompt).length / 1024).toFixed(1)
      } KB) to ${cli} (streaming when possible)...`,
    );
    const promptBytes = new TextEncoder().encode(prompt);
    const result = await runAiCliWithPty(cli, promptBytes);
    const out = result.stdout;
    const err = result.stderr;
    if (!result.success && err) {
      log(
        `  → ${cli} stderr: ${err.slice(0, 500)}${
          err.length > 500 ? "..." : ""
        }`,
      );
    }
    const usage = parseTokenUsage(err);
    if (usage) {
      log(`  → Token usage: ${formatTokenUsage(usage)} (from CLI stderr)`);
    }
    log(`  → Parsing review (${out.length} chars)...`);
    const parsed = parseReviewJson(out);
    if (parsed) {
      log(
        `  → Got review: verdict=${parsed.verdict}, ${
          parsed.inline_comments?.length ?? 0
        } inline comments.`,
      );
      return parsed;
    }
  } catch (e) {
    log(`  → AI CLI failed (using stub): ${e}`);
  }

  // Stub when CLI missing or parse fails
  return {
    summary:
      "*(No AI CLI returned valid JSON. Restart and pick an installed AI at the setup screen.)*",
    verdict: "comment",
    inline_comments: [],
  };
}

/** Extract and parse JSON from AI stdout (may be wrapped in markdown code block). */
function parseReviewJson(stdout: string): ReviewResult | null {
  const trimmed = stdout.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]) as unknown;
      if (o && typeof o === "object" && "summary" in o && "verdict" in o) {
        return {
          summary: String((o as ReviewResult).summary),
          verdict: (o as ReviewResult).verdict,
          inline_comments: Array.isArray((o as ReviewResult).inline_comments)
            ? (o as ReviewResult).inline_comments
            : [],
        };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

// --- AI PR Fixes ---

const FIXES_SYSTEM =
  `You are helping the PR author address review feedback. Your job: read each comment, verify it's still valid for the current code, then fix or address it. Think like a good engineer.

## Principles

- **Read each comment** and check the referenced code. If the code changed and the comment no longer applies, you may skip it (note that in your reply).
- **Think about the whole set of comments first.** What's the theme? Are there larger-scale solutions (one refactor, better abstraction) that address several points at once? Or are these all local, independent fixes? Prefer coherent solutions over one-off patches when it makes sense.
- **Be a good engineer:** clarity, maintainability, minimal unnecessary change. Don't over-engineer; don't under-fix. If a comment is wrong or the current approach is better, you may disagree — explain briefly in the reply.
- **You don't have to agree with every comment.** Consider each one, then make the right decision for the code and project. If you leave something as-is, say why in the comment_replies.

## Your process

1. Read the PR description and the full diff.
2. Read every review (main body) and every inline comment. Note which comments are top-level (no in_reply_to_id) — you'll reply only to those.
3. For each comment: does it still apply? Is there a theme across comments? One refactor or many small edits?
4. Write a short **plan** (what you'll do and why).
5. Produce a **unified diff** that applies to the repo (same format as \`diff -u\`). The diff must be valid and apply cleanly; paths are relative to repo root. Include only the files you change.
6. For each **top-level** inline comment, add a brief **comment_reply**: one line or two saying what you did ("Fixed by …") or why you didn't ("Left as-is because …"). Use the exact comment_id from the input.

## Structured output

Return a single JSON object, nothing else:

{
  "plan": "Short paragraph: approach, theme, what you fixed and what you didn't.",
  "diff": "Full unified diff (e.g. diff -u style) to apply. Must be valid.",
  "comment_replies": [
    { "comment_id": 123, "body": "Fixed by adding a null check." },
    { "comment_id": 124, "body": "Left as-is; the current approach is correct because …" }
  ],
  "commit_message": "Optional. One line for the commit. Default: 'Address PR review feedback'"
}

- \`comment_id\`: use the id from the inline comment list (only include top-level comments).
- \`diff\`: complete unified diff; no extra text before/after. Output only the JSON.`;

/** Build the prompt for the fixes flow: reviews + comments + diff. */
export function buildFixesPrompt(
  diff: string,
  reviews: PrReview[],
  comments: PrReviewComment[],
  prTitle?: string,
  prBody?: string,
): string {
  const topLevel = comments.filter((c) => c.in_reply_to_id == null);
  const parts: string[] = [FIXES_SYSTEM, "\n---\n\n"];
  if (prTitle) parts.push(`# PR: ${prTitle}\n`);
  if (prBody) parts.push(`## Description\n${prBody.slice(0, 2000)}\n`);
  parts.push("## Reviews (main bodies)\n");
  for (const r of reviews) {
    if (r.body && r.body.trim()) {
      parts.push(
        `- [review id=${r.id}] (${r.state}) ${(r.user?.login ?? "?")}: ${
          r.body.slice(0, 1500)
        }\n`,
      );
    }
  }
  parts.push("\n## Inline comments (with comment_id for replies)\n");
  for (const c of comments) {
    const top = c.in_reply_to_id == null
      ? " [TOP-LEVEL — include a reply]"
      : "";
    parts.push(
      `- [comment_id=${c.id}]${top} path=${c.path} line=${c.line ?? "?"} side=${
        c.side ?? "RIGHT"
      }\n  ${(c.diff_hunk ?? "").replace(/\n/g, "\n  ")}\n  Body: ${c.body}\n`,
    );
  }
  parts.push("\n## Current PR diff\n\n");
  parts.push("```diff\n");
  parts.push(diff);
  parts.push("\n```\n\n");
  parts.push(
    `There are ${topLevel.length} top-level comment(s). Include a comment_reply for each (comment_id and body). Output only the JSON.\n`,
  );
  return parts.join("");
}

/**
 * Run the AI CLI for the fixes flow; returns plan, diff, and comment_replies.
 * Uses same CLI-as-API pattern as runReview.
 */
export async function runFixes(
  prompt: string,
  backend: AiBackend = "claude",
  log = (msg: string) => console.log(msg),
): Promise<FixesResult> {
  const cli = backend;
  try {
    log(
      `  → Sending fixes prompt (${
        (new TextEncoder().encode(prompt).length / 1024).toFixed(1)
      } KB) to ${cli} (streaming when possible)...`,
    );
    const promptBytes = new TextEncoder().encode(prompt);
    const result = await runAiCliWithPty(cli, promptBytes);
    const out = result.stdout;
    const err = result.stderr;
    if (!result.success && err) {
      log(
        `  → ${cli} stderr: ${err.slice(0, 500)}${
          err.length > 500 ? "..." : ""
        }`,
      );
    }
    const usage = parseTokenUsage(err);
    if (usage) {
      log(`  → Token usage: ${formatTokenUsage(usage)} (from CLI stderr)`);
    }
    log(`  → Parsing fixes JSON...`);
    const parsed = parseFixesJson(out);
    if (parsed) {
      log(
        `  → Got plan + diff (${parsed.diff.length} chars), ${
          parsed.comment_replies?.length ?? 0
        } comment replies.`,
      );
      return parsed;
    }
  } catch (e) {
    log(`  → AI CLI failed: ${e}`);
  }
  return {
    plan:
      "AI did not return valid output. Restart and pick an installed AI at the setup screen.",
    diff: "",
    comment_replies: [],
  };
}

function parseFixesJson(stdout: string): FixesResult | null {
  const trimmed = stdout.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const o = JSON.parse(jsonMatch[0]) as unknown;
    if (o && typeof o === "object" && "plan" in o && "diff" in o) {
      const r = o as FixesResult;
      const replies = Array.isArray(r.comment_replies)
        ? r.comment_replies.filter(
          (x): x is { comment_id: number; body: string } =>
            typeof x === "object" && x !== null &&
            typeof (x as { comment_id?: number }).comment_id === "number" &&
            typeof (x as { body?: string }).body === "string",
        )
        : [];
      return {
        plan: String(r.plan),
        diff: String(r.diff),
        comment_replies: replies,
        commit_message: r.commit_message != null
          ? String(r.commit_message)
          : undefined,
      };
    }
  } catch {
    // fall through
  }
  return null;
}
