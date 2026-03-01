import type { ReviewResult } from "./types.ts";

const DEFAULT_PROMPT = `You're doing code review for a teammate. Your review gets posted to GitHub. Sound like a direct, thoughtful human — no corporate speak, no filler, no "as an AI". Every comment should earn its place.

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
export function buildPrompt(diff: string, prTitle?: string, prBody?: string): string {
  const header = [
    prTitle && `# PR: ${prTitle}`,
    prBody && `## Description\n${prBody.slice(0, 2000)}`,
    "## Diff\n",
  ]
    .filter(Boolean)
    .join("\n");
  return `${DEFAULT_PROMPT}\n\n---\n\n${header}\n\`\`\`diff\n${diff}\n\`\`\``;
}

export type AiBackend = "claude" | "gemini" | "cursor";

/**
 * Run the configured AI CLI with the prompt and return parsed ReviewResult.
 *
 * **How it works (CLI as API):** We don't call an HTTP API. We spawn the AI CLI (e.g. `claude`)
 * as a subprocess, write the full prompt to its stdin, and read the model's reply from stdout.
 * The CLI handles auth, model choice, and network; we just send text in and get text back.
 * The prompt instructs the model to return a single JSON object so we can parse it and post
 * the review to GitHub.
 *
 * backend: pass from CLI flags (--claude, --gemini, --cursor); defaults to "claude".
 */
export async function runReview(
  prompt: string,
  backend: AiBackend = "claude",
  log = (msg: string) => console.log(msg),
): Promise<ReviewResult> {
  const cli = backend;

  try {
    log(`  → Spawning ${cli} (stdin = prompt, stdout = response)...`);
    const cmd = new Deno.Command(cli, {
      args: [], // CLI-specific: e.g. ["-"] for stdin, or --no-stream
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    const promptBytes = new TextEncoder().encode(prompt);
    log(`  → Sending prompt (${(promptBytes.length / 1024).toFixed(1)} KB)...`);
    await writer.write(promptBytes);
    await writer.close();
    log(`  → Waiting for ${cli} to finish...`);
    const result = await proc.output();
    const out = new TextDecoder().decode(result.stdout);
    const err = new TextDecoder().decode(result.stderr);
    if (!result.success && err) {
      log(`  → ${cli} stderr: ${err.slice(0, 500)}${err.length > 500 ? "..." : ""}`);
    }
    log(`  → Parsing JSON from response (${out.length} chars)...`);
    const parsed = parseReviewJson(out);
    if (parsed) {
      log(`  → Got review: verdict=${parsed.verdict}, ${parsed.inline_comments?.length ?? 0} inline comments.`);
      return parsed;
    }
  } catch (e) {
    log(`  → AI CLI failed (using stub): ${e}`);
  }

  // Stub when CLI missing or parse fails
  return {
    summary: "*(Run with a real AI CLI: use --claude, --gemini, or --cursor and ensure the CLI returns the expected JSON.)*",
    verdict: "comment",
    inline_comments: [],
  };
}

/** Extract and parse JSON from AI stdout (may be wrapped in markdown code block). */
function parseReviewJson(stdout: string): ReviewResult | null {
  const trimmed = stdout.trim();
  // Try raw JSON first
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
