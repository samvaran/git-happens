import type { AiBackend } from "./ai.ts";
import { buildFixesPrompt, buildPrompt, runFixes, runReview } from "./ai.ts";
import { Confirm } from "@cliffy/prompt/confirm";
import { Select } from "@cliffy/prompt/select";
import {
  deletePendingReview,
  fetchPendingReviewStatus,
  fetchPrSizes,
  getCurrentBranchPr,
  getCurrentUserLogin,
  getDiff,
  getPrHeadSha,
  getPrMeta,
  getPrReviewComments,
  getPrReviews,
  getRepo,
  getRepoRoot,
  listMyPrsForFixes,
  listPrsViaSearch,
  openInBrowser,
  submitReview,
} from "./gh.ts";
import type { AppMode } from "./mode_selector.ts";
import { selectMode } from "./mode_selector.ts";
import { pickPr, printPrTable } from "./pr_picker.ts";
import {
  getAvailableBackends,
  printAiInstructionsAndExit,
  printGhInstructionsAndExit,
  printSetupStatus,
  runSetupCheck,
  selectAiBackend,
} from "./setup_check.ts";
import type { GitHubReviewPayload, PRListItem, ReviewResult } from "./types.ts";
import { VERSION } from "./version.ts";

function parseArgs(): { version?: true } {
  const args = Deno.args;
  if (args.includes("--version") || args.includes("-V")) return { version: true };
  return {};
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

async function runFixesFlow(backend: AiBackend): Promise<void> {
  console.log("Fetching your PRs (checking which have review feedback)...\n");
  let prs: PRListItem[];
  try {
    prs = await listMyPrsForFixes();
  } catch (e) {
    console.error("Failed to list PRs (is `gh` installed and authenticated?):", e);
    Deno.exit(1);
  }
  const withFeedback = prs.filter((p) => p.section === "fixes_has_feedback");
  if (withFeedback.length === 0) {
    console.log("No open PRs of yours have review feedback waiting for you.");
    return;
  }

  // Print list of PRs that were reviewed and sent back to you (read-only, same table style as review picker)
  console.log("PRs with review feedback (navigate to the repo and run again to generate fixes):\n");
  printPrTable(withFeedback);
  console.log("— If you're already in one of these repos on the PR branch, we'll generate fixes below.");
  console.log("  Otherwise, cd to the repo (and branch) above and run this again.\n");

  const currentRepo = await getRepo();
  const repoRoot = await getRepoRoot();
  if (!currentRepo || !repoRoot) {
    console.log("Not in a git repo. Navigate to one of the repos above and run again.");
    return;
  }

  const repoSlug = `${currentRepo.owner}/${currentRepo.repo}`;
  const currentPr = await getCurrentBranchPr(repoSlug);
  if (!currentPr) {
    console.log("Current branch has no open PR, or not in one of the listed repos. cd to a PR branch and run again.");
    return;
  }

  const prInList = withFeedback.find(
    (p) =>
      p.repository?.nameWithOwner === repoSlug && p.number === currentPr.number
  );
  if (!prInList) {
    console.log("This branch's PR doesn't have review feedback in the list above. cd to a repo/branch that does.");
    return;
  }

  // We're in the right repo on the right branch. Generate plan + diff only (no git writes).
  console.log(`Generating fixes for ${repoSlug} #${currentPr.number}...\n`);
  let reviews: Awaited<ReturnType<typeof getPrReviews>>;
  let comments: Awaited<ReturnType<typeof getPrReviewComments>>;
  try {
    [reviews, comments] = await Promise.all([
      getPrReviews(currentRepo.owner, currentRepo.repo, currentPr.number),
      getPrReviewComments(currentRepo.owner, currentRepo.repo, currentPr.number),
    ]);
  } catch (e) {
    console.error("Failed to fetch reviews/comments:", e);
    Deno.exit(1);
  }

  const hasFeedback =
    reviews.some((r) => (r.body ?? "").trim()) ||
    comments.some((c) => c.body?.trim());
  if (!hasFeedback) {
    console.log("No review feedback on this PR.");
    return;
  }

  let diff: string;
  try {
    diff = await getDiff(currentPr.number, repoSlug);
  } catch (e) {
    console.error("Failed to get diff:", e);
    Deno.exit(1);
  }

  const meta = await getPrMeta(currentPr.number, repoSlug).catch(() => ({
    title: currentPr.title,
    body: "",
  }));
  const prompt = buildFixesPrompt(diff, reviews, comments, meta.title, meta.body);
  console.log(`Running AI fixes (${backend})...`);
  const result = await runFixes(prompt, backend);

  console.log("\n--- Plan ---\n");
  console.log(result.plan);

  if (result.diff?.trim()) {
    const patchPath = "fixes.patch";
    await Deno.writeTextFile(patchPath, result.diff);
    console.log("\n--- Diff (read-only) ---");
    console.log("Suggested patch written to:", patchPath);
    console.log("To apply it yourself:  git apply " + patchPath);
    console.log("(Then commit, push, and reply to comments as you like.)\n");
  } else {
    console.log("\nAI did not produce a diff.\n");
  }
}

async function main() {
  const { version } = parseArgs();
  if (version) {
    showVersion();
    return;
  }

  const setup = await runSetupCheck();
  printSetupStatus(setup);

  if (!setup.gh.ok) {
    printGhInstructionsAndExit(setup.gh);
  }

  const availableBackends = getAvailableBackends(setup);
  if (availableBackends.length === 0) {
    printAiInstructionsAndExit();
  }

  const backend = await selectAiBackend(availableBackends);
  const stepLabel = availableBackends.length > 1 ? "Step 2 of 2" : "Step 1 of 1";

  let mode: AppMode | null = "review";
  if (Deno.stdin.isTerminal()) {
    mode = await selectMode({ backend, stepLabel });
    if (mode === null) {
      console.log("Cancelled.");
      return;
    }
  }

  if (mode === "fixes") {
    await runFixesFlow(backend);
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

  console.log("Fetching PR sizes and draft status...");
  const [_, currentUser] = await Promise.all([
    fetchPrSizes(prs),
    getCurrentUserLogin().catch(() => ""),
  ]);
  if (currentUser) {
    await fetchPendingReviewStatus(prs, currentUser);
  }

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

  if (pr.userHasPendingReview) {
    const runNew = await Confirm.prompt({
      message: "You already have a draft review on this PR. Run a new AI review and replace it? (No = open PR in browser, no AI)",
      default: false,
    });
    if (!runNew) {
      const prUrl = pr.url ?? (repo ? `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}` : "");
      if (prUrl) {
        console.log("Opening PR so you can submit or edit your existing draft.");
        openInBrowser(prUrl);
        console.log(prUrl);
      }
      return;
    }
  }

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

  const payload = mapToGitHubPayload(review);
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";

  console.log("");
  console.log(bold + "Review" + reset);
  console.log(dim + `Verdict: ${payload.event}` + reset);
  console.log("");
  console.log(payload.body);
  if (payload.comments?.length) {
    console.log("");
    console.log(dim + `Inline comments (${payload.comments.length}):` + reset);
    for (const c of payload.comments) {
      console.log("");
      console.log(dim + `  ${c.path}:${c.line} (${c.side})` + reset);
      console.log("  " + c.body.split("\n").join("\n  "));
    }
  }
  console.log("");
  const submit = await Confirm.prompt({
    message: "Post as draft review and open in browser? (You can edit and submit there.)",
    default: true,
  });

  if (!submit) {
    console.log("Not submitted.");
    return;
  }

  if (!repo) {
    console.error("Could not determine repo (pick a PR that has repo info, or run from a gh repo).");
    Deno.exit(1);
  }

  const prUrl = pr.url ?? `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}`;

  if (pr.userHasPendingReview && pr.pendingReviewId != null) {
    try {
      await deletePendingReview(repo.owner, repo.repo, pr.number, pr.pendingReviewId);
    } catch (e) {
      console.error("Failed to remove existing draft:", e);
      Deno.exit(1);
    }
  }

  try {
    const commitId = await getPrHeadSha(repo.owner, repo.repo, pr.number);
    // Draft = omit event (API: "leave the event parameter blank" for PENDING)
    const draftPayload = { body: payload.body, commit_id: commitId, ...(payload.comments?.length ? { comments: payload.comments } : {}) };
    await submitReview(repo.owner, repo.repo, pr.number, draftPayload);
    console.log("Draft review posted. Opening PR in browser...");
    openInBrowser(prUrl);
    console.log(prUrl);
  } catch (e) {
    console.error("Failed to post draft review:", e);
    Deno.exit(1);
  }
}

main();
