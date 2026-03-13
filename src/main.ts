import type { AiBackend } from "./ai.ts";
import {
  buildFixesPrompt,
  buildPrompt,
  runCommitFix,
  runFixes,
  runReview,
} from "./ai.ts";
import { Confirm } from "@cliffy/prompt/confirm";
import { Select } from "@cliffy/prompt/select";
import {
  applyPatch,
  createDraftReview,
  deletePendingReview,
  fetchPendingReviewStatus,
  fetchPrSizes,
  getCurrentBranchName,
  getCurrentUserLogin,
  getDiff,
  getDiffWithContext,
  getPrHeadRefName,
  getPrHeadSha,
  getPrIssueComments,
  getPrMeta,
  getPrReviewComments,
  getPrReviews,
  getRepo,
  getRepoRoot,
  getReviewerLoginsFromReviews,
  isProtectedBranch,
  listMyPrsForFixes,
  listPrsViaSearch,
  openInBrowser,
  postPrIssueComment,
  replyToReviewComment,
  requestReviewers,
  runGit,
  runGitAllowFailure,
  updateReviewBody,
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
  if (args.includes("--version") || args.includes("-V")) {
    return { version: true };
  }
  return {};
}

function showVersion(): void {
  console.log(VERSION);
}

function mapToGitHubPayload(review: ReviewResult): GitHubReviewPayload {
  const event = review.verdict === "approve"
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
    console.error(
      "Failed to list PRs (is `gh` installed and authenticated?):",
      e,
    );
    Deno.exit(1);
  }
  const withFeedback = prs.filter((p) => p.section === "fixes_has_feedback");
  if (withFeedback.length === 0) {
    console.log("No open PRs of yours have review feedback waiting for you.");
    return;
  }

  console.log("Pick a PR to address (fixes flow):\n");
  printPrTable(prs);
  const pr = Deno.stdin.isTerminal()
    ? await pickPr(prs, { fixesMode: true })
    : (withFeedback[0] ?? prs[0]);
  if (!pr) {
    console.log("Cancelled.");
    return;
  }

  const repo = pr.repository?.nameWithOwner
    ? {
      owner: pr.repository.nameWithOwner.split("/")[0],
      repo: pr.repository.nameWithOwner.split("/")[1],
    }
    : await getRepo();
  if (!repo) {
    console.log(
      "Could not determine repo for this PR. Run from the PR's repo or ensure the PR list includes repo info.",
    );
    return;
  }
  const repoSlug = `${repo.owner}/${repo.repo}`;
  const repoRoot = await getRepoRoot();
  const currentRepo = await getRepo();
  const currentBranch = repoRoot ? await getCurrentBranchName(repoRoot) : null;
  const headRef = pr.headRefName?.trim() ||
    (await getPrHeadRefName(pr.number, repoSlug));

  const repoMatches = currentRepo &&
    currentRepo.owner === repo.owner &&
    currentRepo.repo === repo.repo;
  if (!repoRoot || !repoMatches) {
    console.log(
      `Not in the repo for this PR. cd to the repo (${repoSlug}) and run again.`,
    );
    return;
  }
  if (currentBranch !== headRef) {
    console.log(
      `Current branch is "${
        currentBranch ?? "?"
      }", but this PR is on "${headRef}". Run: git checkout ${headRef}\nThen run git-happens again.`,
    );
    return;
  }

  console.log(`\nGathering feedback for ${repoSlug} #${pr.number}...\n`);
  let reviews: Awaited<ReturnType<typeof getPrReviews>>;
  let comments: Awaited<ReturnType<typeof getPrReviewComments>>;
  let issueComments: Awaited<ReturnType<typeof getPrIssueComments>>;
  try {
    [reviews, comments, issueComments] = await Promise.all([
      getPrReviews(repo.owner, repo.repo, pr.number),
      getPrReviewComments(repo.owner, repo.repo, pr.number),
      getPrIssueComments(repo.owner, repo.repo, pr.number),
    ]);
  } catch (e) {
    console.error("Failed to fetch reviews/comments:", e);
    Deno.exit(1);
  }

  const hasFeedback = reviews.some((r) => (r.body ?? "").trim()) ||
    comments.some((c) => c.body?.trim()) ||
    issueComments.length > 0;
  if (!hasFeedback) {
    console.log("No review feedback on this PR.");
    return;
  }

  let diff: string;
  try {
    diff = await getDiff(pr.number, repoSlug);
  } catch (e) {
    console.error("Failed to get diff:", e);
    Deno.exit(1);
  }

  const meta = await getPrMeta(pr.number, repoSlug).catch(() => ({
    title: pr.title,
    body: "",
  }));
  const prompt = buildFixesPrompt(
    diff,
    reviews,
    comments,
    issueComments,
    meta.title,
    meta.body,
  );
  console.log(`Running AI fixes (${backend})...`);
  const result = await runFixes(prompt, backend);

  if (!result.diff?.trim()) {
    console.log("\nAI did not produce a diff. Nothing to apply.");
    return;
  }

  const applyResult = await applyPatch(repoRoot, result.diff);
  if (!applyResult.success) {
    console.error("Failed to apply patch:", applyResult.stderr);
    console.log(
      "You can try applying manually or adjust the diff. Patch was from AI.",
    );
    Deno.exit(1);
  }

  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  console.log("\n" + bold + "Plan" + reset + "\n");
  console.log(result.plan);
  if (result.base_comment?.trim()) {
    console.log(
      "\n" + bold + "Draft base comment (will post after push)" + reset + "\n",
    );
    console.log(result.base_comment);
  }
  if (result.comment_replies?.length) {
    console.log("\n" + bold + "Draft replies to inline comments" + reset);
    for (const r of result.comment_replies) {
      console.log(dim + `  Comment ${r.comment_id}:` + reset);
      console.log("  " + r.body.split("\n").join("\n  "));
    }
  }
  console.log("");

  const proceed = await Confirm.prompt({
    message:
      "Apply these changes, commit, push, post comments, and re-request review?",
    default: true,
  });
  if (!proceed) {
    console.log(
      "Stopped. Changes are in your working tree; commit/push manually.",
    );
    return;
  }

  const commitMessage = result.commit_message?.trim() ??
    "Address PR review feedback";
  const maxCommitRetries = 5;
  let lastStderr = "";
  for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
    await runGit(["add", "-A"], repoRoot);
    const commitResult = await runGitAllowFailure(
      ["commit", "-m", commitMessage],
      repoRoot,
    );
    if (commitResult.success) break;
    lastStderr = commitResult.stderr;
    if (attempt === maxCommitRetries - 1) {
      console.error("Commit failed after retries:", lastStderr);
      Deno.exit(1);
    }
    console.log("Commit failed (e.g. lint/hook). Asking AI to fix...");
    const fixDiff = await runCommitFix(lastStderr, backend);
    if (!fixDiff?.trim()) {
      console.error("AI could not produce a fix. Stderr was:", lastStderr);
      Deno.exit(1);
    }
    const fixApply = await applyPatch(repoRoot, fixDiff);
    if (!fixApply.success) {
      console.error("Failed to apply fix patch:", fixApply.stderr);
      Deno.exit(1);
    }
  }

  if (isProtectedBranch(currentBranch ?? "")) {
    console.error(
      `Refusing to push: branch "${currentBranch}" is protected (main/master).`,
    );
    Deno.exit(1);
  }
  try {
    await runGit(["push", "origin", currentBranch!], repoRoot);
  } catch (e) {
    console.error("Push failed:", e);
    Deno.exit(1);
  }

  if (result.base_comment?.trim()) {
    try {
      await postPrIssueComment(
        repo.owner,
        repo.repo,
        pr.number,
        result.base_comment,
      );
    } catch (e) {
      console.error("Failed to post base comment:", e);
    }
  }
  for (const r of result.comment_replies ?? []) {
    try {
      await replyToReviewComment(
        repo.owner,
        repo.repo,
        pr.number,
        r.comment_id,
        r.body,
      );
    } catch (e) {
      console.error(`Failed to reply to comment ${r.comment_id}:`, e);
    }
  }
  const reviewerLogins = getReviewerLoginsFromReviews(reviews);
  if (reviewerLogins.length > 0) {
    try {
      await requestReviewers(repo.owner, repo.repo, pr.number, reviewerLogins);
      console.log("Re-requested review from:", reviewerLogins.join(", "));
    } catch (e) {
      console.error("Failed to re-request reviewers:", e);
    }
  }

  console.log("\nDone. PR updated, comments posted, reviewers re-requested.");
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
  const stepLabel = availableBackends.length > 1
    ? "Step 2 of 2"
    : "Step 1 of 1";

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
    console.error(
      "Failed to list PRs (is `gh` installed and authenticated?):",
      e,
    );
    Deno.exit(1);
  }

  if (prs.length === 0) {
    console.log(
      "No PRs found (assigned to you, review-requested, other open, or authored by you).",
    );
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
      const size = p.additions != null && p.deletions != null
        ? ` (+${p.additions} -${p.deletions})`
        : "";
      return {
        name: `#${p.number} ${p.title} (${p.author.login})${size}`,
        value: p,
      };
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
    ? {
      owner: pr.repository.nameWithOwner.split("/")[0],
      repo: pr.repository.nameWithOwner.split("/")[1],
    }
    : await getRepo();
  const repoSlug = repo ? `${repo.owner}/${repo.repo}` : undefined;

  if (pr.userHasPendingReview) {
    const runNew = await Confirm.prompt({
      message:
        "You already have a draft review on this PR. Run a new AI review and replace it? (No = open PR in browser, no AI)",
      default: false,
    });
    if (!runNew) {
      const prUrl = pr.url ??
        (repo
          ? `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}`
          : "");
      if (prUrl) {
        console.log(
          "Opening PR so you can submit or edit your existing draft.",
        );
        openInBrowser(prUrl);
        console.log(prUrl);
      }
      return;
    }
  }

  console.log("\nFetching diff and file context...");
  let diff: string;
  let fileContext = "";
  try {
    if (repo) {
      const out = await getDiffWithContext(
        pr.number,
        repo.owner,
        repo.repo,
        repoSlug,
      );
      diff = out.diff;
      fileContext = out.fileContext;
    } else {
      diff = await getDiff(pr.number, repoSlug);
    }
  } catch (e) {
    console.error("Failed to get diff:", e);
    Deno.exit(1);
  }

  const meta = await getPrMeta(pr.number, repoSlug).catch(() => ({
    title: pr.title,
    body: "",
  }));
  const prompt = buildPrompt(diff, meta.title, meta.body, fileContext);
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
    message:
      "Post as draft review and open in browser? (You can edit and submit there.)",
    default: true,
  });

  if (!submit) {
    console.log("Not submitted.");
    return;
  }

  if (!repo) {
    console.error(
      "Could not determine repo (pick a PR that has repo info, or run from a gh repo).",
    );
    Deno.exit(1);
  }

  const prUrl = pr.url ??
    `https://github.com/${repo.owner}/${repo.repo}/pull/${pr.number}`;

  if (pr.userHasPendingReview && pr.pendingReviewId != null) {
    try {
      await deletePendingReview(
        repo.owner,
        repo.repo,
        pr.number,
        pr.pendingReviewId,
      );
    } catch (e) {
      console.error("Failed to remove existing draft:", e);
      Deno.exit(1);
    }
  }

  try {
    const commitId = await getPrHeadSha(repo.owner, repo.repo, pr.number);
    // Create draft with comments only (no body); then set body via PUT so the summary is the review body, not a vanilla comment.
    const reviewId = await createDraftReview(repo.owner, repo.repo, pr.number, {
      commit_id: commitId,
      comments: payload.comments?.length ? payload.comments : undefined,
      bodyWhenNoComments: payload.comments?.length ? undefined : payload.body,
    });
    if (payload.body?.trim()) {
      await updateReviewBody(
        repo.owner,
        repo.repo,
        pr.number,
        reviewId,
        payload.body,
      );
    }
    console.log("Draft review posted. Opening PR in browser...");
    openInBrowser(prUrl);
    console.log(prUrl);
  } catch (e) {
    console.error("Failed to post draft review:", e);
    Deno.exit(1);
  }
}

main();
