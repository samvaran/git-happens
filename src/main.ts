import type { AiBackend } from "./ai.ts";
import { buildPrompt, runReview } from "./ai.ts";
import { Confirm } from "@cliffy/prompt/confirm";
import { Select } from "@cliffy/prompt/select";
import { fetchPrSizes, getDiff, getPrMeta, getRepo, listPrsViaSearch, submitReview } from "./gh.ts";
import { pickPr } from "./pr_picker.ts";
import type { GitHubReviewPayload, PRListItem, ReviewResult } from "./types.ts";
import { VERSION } from "./version.ts";

function parseArgs(): { backend: AiBackend; version?: true } {
  const args = Deno.args;
  if (args.includes("--version") || args.includes("-V")) return { backend: "claude", version: true };
  if (args.includes("--claude")) return { backend: "claude" };
  if (args.includes("--gemini")) return { backend: "gemini" };
  if (args.includes("--cursor")) return { backend: "cursor" };
  return { backend: "claude" };
}

function showVersion(): void {
  console.log(VERSION);
}

function mapToGitHubPayload(review: ReviewResult): GitHubReviewPayload {
  const event =
    review.verdict === "approve"
      ? "APPROVE"
      : review.verdict === "request_changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";
  return {
    event,
    body: review.summary,
    ...(review.inline_comments?.length
      ? {
          comments: review.inline_comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
        ...(c.start_line != null && { start_line: c.start_line }),
            ...(c.start_side && { start_side: c.start_side }),
          })),
        }
      : {}),
  };
}

async function main() {
  const { backend, version } = parseArgs();
  if (version) {
    showVersion();
    return;
  }
  console.log("Fetching PRs...\n");
  let prs: PRListItem[];
  try {
    prs = await listPrsViaSearch();
  } catch (e) {
    console.error("Failed to list PRs (is `gh` installed and authenticated?):", e);
    Deno.exit(1);
  }

  if (prs.length === 0) {
    console.log("No PRs found (assigned to you, review-requested, other open, or authored by you).");
    return;
  }

  console.log("Fetching PR sizes...");
  await fetchPrSizes(prs);

  let pr: PRListItem | null;
  if (Deno.stdin.isTerminal()) {
    pr = await pickPr(prs);
  } else {
    const options = prs.map((p) => {
      const size =
        p.additions != null && p.deletions != null
          ? ` (+${p.additions} -${p.deletions})`
          : "";
      return { name: `#${p.number} ${p.title} (${p.author.login})${size}`, value: p };
    });
    pr = (await Select.prompt({
      message: "Pick a PR to review",
      options,
      search: true,
      maxRows: 12,
    })) as PRListItem | null;
  }

  if (!pr) {
    console.log("Cancelled.");
    return;
  }
  // Repo from selected PR (when from search) or from current directory
  const repo = pr.repository?.nameWithOwner
    ? { owner: pr.repository.nameWithOwner.split("/")[0], repo: pr.repository.nameWithOwner.split("/")[1] }
    : await getRepo();
  const repoSlug = repo ? `${repo.owner}/${repo.repo}` : undefined;

  console.log("\nFetching diff...");
  let diff: string;
  try {
    diff = await getDiff(pr.number, repoSlug);
  } catch (e) {
    console.error("Failed to get diff:", e);
    Deno.exit(1);
  }

  const meta = await getPrMeta(pr.number, repoSlug).catch(() => ({ title: pr.title, body: "" }));
  const prompt = buildPrompt(diff, meta.title, meta.body);
  console.log(`Running AI review (${backend})...`);
  const review = await runReview(prompt, backend);

  console.log("\n--- Review (AI output) ---\n");
  console.log(review.summary);
  console.log("\nVerdict:", review.verdict);

  const payload = mapToGitHubPayload(review);
  console.log("\n" + "─".repeat(60));
  console.log("Preview of what will be submitted to GitHub:");
  console.log("─".repeat(60));
  console.log("\nReview body:\n");
  console.log(payload.body);
  if (payload.comments?.length) {
    console.log("\nInline comments:");
    for (const c of payload.comments) {
      console.log(`\n  ${c.path} (line ${c.line}, ${c.side}):`);
      console.log("  " + c.body.split("\n").join("\n  "));
    }
  }
  console.log("\n" + "─".repeat(60));
  console.log("Event:", payload.event);
  console.log("─".repeat(60) + "\n");

  const submit = await Confirm.prompt({
    message: "Submit this review to GitHub?",
    default: false,
  });

  if (!submit) {
    console.log("Not submitted.");
    return;
  }

  if (!repo) {
    console.error("Could not determine repo (pick a PR that has repo info, or run from a gh repo).");
    Deno.exit(1);
  }

  try {
    await submitReview(repo.owner, repo.repo, pr.number, payload);
    console.log("Review submitted.");
  } catch (e) {
    console.error("Failed to submit review:", e);
    Deno.exit(1);
  }
}

main();
