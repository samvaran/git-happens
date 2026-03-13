import type {
  GitHubReviewPayload,
  IssueComment,
  PRListItem,
  PrReview,
  PrReviewComment,
} from "./types.ts";

const GH = "gh";

/** Run gh with args; returns stdout. Throws on non-zero exit. */
async function gh(args: string[], stdin?: string): Promise<string> {
  const cmd = new Deno.Command(GH, {
    args,
    stdin: stdin !== undefined ? "piped" : "inherit",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  if (stdin !== undefined) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const result = await proc.output();
  const out = new TextDecoder().decode(result.stdout);
  const err = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`gh ${args.join(" ")} failed: ${err || result.code}`);
  }
  return out;
}

/** List PRs assigned to you or where you're requested for review (current repo only; requires cwd to be a git repo). */
export async function listPrs(options?: {
  repo?: string;
  assignee?: boolean;
  reviewRequested?: boolean;
}): Promise<PRListItem[]> {
  const args = [
    "pr",
    "list",
    "--json",
    "number,title,author,headRefName,baseRefName,url",
  ];
  if (options?.repo) args.push("-R", options.repo);
  if (options?.assignee !== false) args.push("--assignee", "@me");
  if (options?.reviewRequested) {
    args.push("--search", "review-requested:@me");
  }
  const raw = await gh(args);
  const data = JSON.parse(raw) as PRListItem[];
  return Array.isArray(data) ? data : [];
}

/** Search result item from `gh search prs --json ...` */
interface SearchPRItem {
  number: number;
  title: string;
  author?: { login?: string };
  repository?: { nameWithOwner?: string };
  url?: string;
}

/** List PRs via search: assigned, review-requested, other open (involves you, not in above), then my PRs. Directory-agnostic. */
export async function listPrsViaSearch(): Promise<PRListItem[]> {
  const [assigned, reviewRequested, myPrs, involvesMe] = await Promise.all([
    listPrsViaSearchSection("assigned"),
    listPrsViaSearchSection("review_requested"),
    listPrsViaSearchSection("my_prs"),
    listPrsViaSearchSection("open_other"),
  ]);
  const byKey = new Map<string, PRListItem>();
  const sectionPriority: (typeof assigned)[0]["section"][] = [
    "assigned",
    "review_requested",
    "my_prs",
    "open_other",
  ];
  for (const list of [assigned, reviewRequested, myPrs, involvesMe]) {
    for (const p of list) {
      const key = p.repository
        ? `${p.repository.nameWithOwner}#${p.number}`
        : "";
      if (!key) continue;
      const existing = byKey.get(key);
      const existingPri = existing
        ? sectionPriority.indexOf(existing.section!)
        : 99;
      const newPri = sectionPriority.indexOf(p.section!);
      if (!existing || newPri < existingPri) byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

async function listPrsViaSearchSection(
  section: "assigned" | "review_requested" | "open_other" | "my_prs",
): Promise<PRListItem[]> {
  const flag = section === "assigned"
    ? ["--assignee=@me"]
    : section === "review_requested"
    ? ["--review-requested=@me"]
    : section === "open_other"
    ? ["--involves=@me"]
    : ["--author=@me"];
  const args = [
    "search",
    "prs",
    ...flag,
    "--state=open",
    "--json",
    "number,title,author,repository,url",
    "--limit",
    "50",
  ];
  try {
    const raw = await gh(args);
    const data = JSON.parse(raw) as SearchPRItem[];
    if (!Array.isArray(data)) return [];
    return data
      .filter((
        p,
      ): p is SearchPRItem & { repository: { nameWithOwner: string } } =>
        Boolean(p.repository?.nameWithOwner)
      )
      .map((p) => ({
        number: p.number,
        title: p.title,
        author: { login: p.author?.login ?? "?" },
        url: p.url,
        repository: { nameWithOwner: p.repository.nameWithOwner },
        section,
      }));
  } catch {
    return [];
  }
}

/** Fetch additions/deletions for each PR (batched). Mutates items in place. */
export async function fetchPrSizes(
  prs: PRListItem[],
  batchSize = 10,
): Promise<void> {
  const withRepo = prs.filter((p) => p.repository?.nameWithOwner);
  for (let i = 0; i < withRepo.length; i += batchSize) {
    const batch = withRepo.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (p) => {
        const repo = p.repository!.nameWithOwner;
        try {
          const raw = await gh([
            "pr",
            "view",
            String(p.number),
            "-R",
            repo,
            "--json",
            "additions,deletions",
          ]);
          const data = JSON.parse(raw) as {
            additions?: number;
            deletions?: number;
          };
          p.additions = data.additions ?? 0;
          p.deletions = data.deletions ?? 0;
        } catch {
          p.additions = 0;
          p.deletions = 0;
        }
      }),
    );
  }
}

/** Get PR diff (same as GitHub web UI). Uses default 3 lines of context. */
export async function getDiff(
  prNumber: number,
  repo?: string,
): Promise<string> {
  const args = ["pr", "diff", String(prNumber)];
  if (repo) args.push("-R", repo);
  return await gh(args);
}

/** Extract changed file paths from a unified diff (new side, e.g. +++ b/path). Skips /dev/null (deleted files). */
export function getChangedPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) {
      const p = m[1].trim();
      if (p !== "/dev/null") paths.push(p);
    }
  }
  return [...new Set(paths)];
}

/** Max lines of file content to include per file for context (avoids huge prompts). */
export const FILE_CONTEXT_MAX_LINES = 400;

/** Fetch one file at the given ref (e.g. PR head SHA). Returns decoded text or null if not a text file or missing. */
export async function getFileContentAtRef(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  maxLines = FILE_CONTEXT_MAX_LINES,
): Promise<string | null> {
  try {
    const pathEnc = path.split("/").map(encodeURIComponent).join("/");
    const raw = await gh([
      "api",
      `repos/${owner}/${repo}/contents/${pathEnc}?ref=${ref}`,
      "-q",
      ".content",
    ]);
    const contentB64 = (raw ?? "").trim();
    if (!contentB64) return null;
    const binary = Uint8Array.from(atob(contentB64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(binary);
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join("\n") + "\n... (truncated)";
  } catch {
    return null;
  }
}

/**
 * Get PR diff plus full file context for changed files (at PR head) so the AI sees neighboring code.
 * Skips binary/large files; limits lines per file to FILE_CONTEXT_MAX_LINES.
 */
export async function getDiffWithContext(
  prNumber: number,
  owner: string,
  repo: string,
  repoSlug?: string,
): Promise<{ diff: string; fileContext: string }> {
  const diff = await getDiff(prNumber, repoSlug ?? `${owner}/${repo}`);
  const headSha = await getPrHeadSha(owner, repo, prNumber);
  const paths = getChangedPathsFromDiff(diff);
  const parts: string[] = [];
  for (const path of paths) {
    const content = await getFileContentAtRef(owner, repo, headSha, path);
    if (content != null) {
      parts.push(`### ${path}\n\n\`\`\`\n${content}\n\`\`\``);
    }
  }
  const fileContext = parts.length ? parts.join("\n\n") : "";
  return { diff, fileContext };
}

/** Get PR title and body for the prompt (optional). */
export async function getPrMeta(
  prNumber: number,
  repo?: string,
): Promise<{ title: string; body: string }> {
  const args = ["pr", "view", String(prNumber), "--json", "title,body"];
  if (repo) args.push("-R", repo);
  const raw = await gh(args);
  const data = JSON.parse(raw) as { title: string; body: string };
  return { title: data.title ?? "", body: data.body ?? "" };
}

/** Get the head ref name (branch) for a PR. */
export async function getPrHeadRefName(
  prNumber: number,
  repo?: string,
): Promise<string> {
  const args = ["pr", "view", String(prNumber), "--json", "headRefName"];
  if (repo) args.push("-R", repo);
  const raw = await gh(args);
  const data = JSON.parse(raw) as { headRefName?: string };
  return data.headRefName ?? "";
}

/** Resolve owner/repo from current directory (e.g. for gh api). */
export async function getRepo(): Promise<
  { owner: string; repo: string } | null
> {
  try {
    const raw = await gh(["repo", "view", "--json", "nameWithOwner"]);
    const data = JSON.parse(raw) as { nameWithOwner: string };
    const [owner, repo] = (data.nameWithOwner ?? "").split("/");
    if (owner && repo) return { owner, repo };
  } catch {
    // not in a gh repo
  }
  return null;
}

/** Run git; returns stdout. Throws on non-zero exit. */
export async function runGit(args: string[], cwd?: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: cwd ?? undefined,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.spawn().output();
  const out = new TextDecoder().decode(result.stdout);
  const err = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`git ${args.join(" ")} failed: ${err || result.code}`);
  }
  return out;
}

/** Run git; returns stdout, stderr, and success. Does not throw. */
export async function runGitAllowFailure(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: cwd ?? undefined,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.spawn().output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    success: result.success,
  };
}

/** Current branch name (e.g. "feature/foo"). */
export async function getCurrentBranchName(
  cwd?: string,
): Promise<string | null> {
  const r = await runGitAllowFailure(["branch", "--show-current"], cwd);
  if (!r.success) return null;
  return r.stdout.trim() || null;
}

/** Get the repository root directory (for running git apply etc.). */
export async function getRepoRoot(): Promise<string | null> {
  try {
    const out = await runGit(["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Get the open PR for the current branch in the current repo, if any. Read-only. */
export async function getCurrentBranchPr(
  repoSlug: string,
): Promise<{ number: number; title: string; url: string } | null> {
  try {
    const raw = await gh([
      "pr",
      "view",
      "-R",
      repoSlug,
      "--json",
      "number,title,url",
    ]);
    const data = JSON.parse(raw) as {
      number: number;
      title?: string;
      url?: string;
    };
    if (typeof data.number !== "number") return null;
    return {
      number: data.number,
      title: data.title ?? "",
      url: data.url ?? "",
    };
  } catch {
    return null;
  }
}

/** Get the head commit SHA of a PR (required for PENDING/draft reviews). */
export async function getPrHeadSha(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}`;
  const raw = await gh(["api", path, "-q", ".head.sha"]);
  return raw.trim();
}

/**
 * Create a draft (PENDING) review: POST with commit_id and optional comments.
 * Does NOT send body when there are comments — use updateReviewBody after so the summary is stored as the review body, not as a vanilla comment.
 * When there are no comments, body is included so the API accepts the create; we still call updateReviewBody to set the summary.
 * Returns the created review id.
 */
export async function createDraftReview(
  owner: string,
  repo: string,
  pullNumber: number,
  payload: {
    commit_id: string;
    comments?: GitHubReviewPayload["comments"];
    /** Include when there are no comments so the create request is valid. */
    bodyWhenNoComments?: string;
  },
): Promise<number> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const hasComments = (payload.comments?.length ?? 0) > 0;
  const body = JSON.stringify({
    commit_id: payload.commit_id,
    ...(hasComments ? { comments: payload.comments } : {}),
    ...(!hasComments && payload.bodyWhenNoComments != null
      ? { body: payload.bodyWhenNoComments }
      : {}),
  });
  const raw = await gh(["api", path, "--input", "-"], body);
  const data = JSON.parse(raw) as { id: number };
  return data.id;
}

/** Update the body (summary) of an existing review. Use after createDraftReview so the main comment is the review summary. */
export async function updateReviewBody(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  body: string,
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`;
  await gh(
    ["api", path, "-X", "PUT", "--input", "-"],
    JSON.stringify({ body }),
  );
}

/** Open a URL in the default browser. */
export function openInBrowser(url: string): void {
  const cmd = Deno.build.os === "windows"
    ? "start"
    : Deno.build.os === "darwin"
    ? "open"
    : "xdg-open";
  new Deno.Command(cmd, { args: [url] }).spawn();
}

/** Current GitHub user login (for comparing review ownership). */
export async function getCurrentUserLogin(): Promise<string> {
  const raw = await gh(["api", "user", "-q", ".login"]);
  return raw.trim();
}

/** List all reviews for a PR (main review bodies). */
export async function getPrReviews(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrReview[]> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const raw = await gh(["api", path, "--paginate"]);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map((
    r: {
      id: number;
      body?: string | null;
      state?: string;
      user?: { login?: string };
    },
  ) => ({
    id: r.id,
    body: r.body ?? null,
    state: r.state ?? "",
    user: r.user,
  }));
}

/** If the given user has a pending review on this PR, return its id; otherwise null. */
export async function getPendingReview(
  owner: string,
  repo: string,
  pullNumber: number,
  userLogin: string,
): Promise<{ id: number } | null> {
  const reviews = await getPrReviews(owner, repo, pullNumber);
  const pending = reviews.find((r) =>
    r.state === "PENDING" && r.user?.login === userLogin
  );
  return pending ? { id: pending.id } : null;
}

/** Delete a pending (draft) review. Use before posting a new draft if replacing. */
export async function deletePendingReview(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`;
  await gh(["api", path, "-X", "DELETE"]);
}

/** Fill userHasPendingReview and pendingReviewId for each PR. Mutates items in place. Batched. */
export async function fetchPendingReviewStatus(
  prs: PRListItem[],
  currentUserLogin: string,
  batchSize = 8,
): Promise<void> {
  const withRepo = prs.filter((p) => p.repository?.nameWithOwner);
  for (let i = 0; i < withRepo.length; i += batchSize) {
    const batch = withRepo.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (p) => {
        const repo = p.repository!.nameWithOwner;
        const [owner, repoName] = repo.split("/");
        try {
          const pending = await getPendingReview(
            owner,
            repoName,
            p.number,
            currentUserLogin,
          );
          (p as PRListItem).userHasPendingReview = pending != null;
          (p as PRListItem).pendingReviewId = pending?.id;
        } catch {
          (p as PRListItem).userHasPendingReview = false;
        }
      }),
    );
  }
}

/** List all review comments (inline) for a PR. */
export async function getPrReviewComments(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrReviewComment[]> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  const raw = await gh(["api", path, "--paginate"]);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map(
    (c: {
      id: number;
      body?: string;
      path?: string;
      line?: number | null;
      side?: string;
      diff_hunk?: string;
      in_reply_to_id?: number | null;
      user?: { login?: string };
    }) => ({
      id: c.id,
      body: c.body ?? "",
      path: c.path ?? "",
      line: c.line ?? null,
      side: c.side === "LEFT" || c.side === "RIGHT" ? c.side : undefined,
      diff_hunk: c.diff_hunk,
      in_reply_to_id: c.in_reply_to_id ?? null,
      user: c.user,
    }),
  );
}

/** True if the PR has any review body or inline comments (something to address). */
export async function prHasReviewFeedback(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<boolean> {
  const [reviews, comments] = await Promise.all([
    getPrReviews(owner, repo, pullNumber),
    getPrReviewComments(owner, repo, pullNumber),
  ]);
  return (
    reviews.some((r) => (r.body ?? "").trim().length > 0) || comments.length > 0
  );
}

/** List my PRs only, with section = fixes_has_feedback (has review feedback) or fixes_other. */
export async function listMyPrsForFixes(): Promise<PRListItem[]> {
  const myPrs = await listPrsViaSearchSection("my_prs");
  if (myPrs.length === 0) return [];
  await fetchPrSizes(myPrs);
  const withSection = await Promise.all(
    myPrs.map(async (p) => {
      const repo = p.repository?.nameWithOwner;
      if (!repo) return { ...p, section: "fixes_other" as const };
      const [owner, repoName] = repo.split("/");
      const hasFeedback = await prHasReviewFeedback(owner, repoName, p.number);
      const section: "fixes_has_feedback" | "fixes_other" = hasFeedback
        ? "fixes_has_feedback"
        : "fixes_other";
      return { ...p, section };
    }),
  );
  return withSection;
}

/** Reply to a review comment (creates a new comment with in_reply_to_id). */
export async function replyToReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  await gh(
    ["api", path, "-X", "POST", "--input", "-"],
    JSON.stringify({ body, in_reply_to_id: commentId }),
  );
}

/** List issue/PR-level comments (not inline on the diff). */
export async function getPrIssueComments(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<IssueComment[]> {
  const path = `repos/${owner}/${repo}/issues/${pullNumber}/comments`;
  const raw = await gh(["api", path, "--paginate"]);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map(
    (c: { id: number; body?: string; user?: { login?: string } }) => ({
      id: c.id,
      body: c.body ?? "",
      user: c.user,
    }),
  );
}

/** Post a new issue/PR-level comment (e.g. base comment after addressing feedback). */
export async function postPrIssueComment(
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  const path = `repos/${owner}/${repo}/issues/${pullNumber}/comments`;
  await gh(
    ["api", path, "-X", "POST", "--input", "-"],
    JSON.stringify({ body }),
  );
}

/** Known bot logins to exclude when re-requesting review (lowercase). */
const REVIEW_BOT_LOGINS = new Set([
  "cursor",
  "cursor[bot]",
  "github-actions[bot]",
  "greptile",
  "greptile[bot]",
  "codacy-bot",
  "codeclimate",
  "dependabot",
  "dependabot[bot]",
  "snyk-bot",
]);

/** Extract reviewer logins from reviews (who submitted a review), excluding bots. */
export function getReviewerLoginsFromReviews(
  reviews: PrReview[],
): string[] {
  const logins = new Set<string>();
  for (const r of reviews) {
    const login = r.user?.login;
    if (login && !REVIEW_BOT_LOGINS.has(login.toLowerCase())) {
      logins.add(login);
    }
  }
  return [...logins];
}

/** Re-request review from the given users. */
export async function requestReviewers(
  owner: string,
  repo: string,
  pullNumber: number,
  logins: string[],
): Promise<void> {
  if (logins.length === 0) return;
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`;
  await gh(
    ["api", path, "-X", "POST", "--input", "-"],
    JSON.stringify({ reviewers: logins }),
  );
}

/**
 * Apply a unified diff (patch) in the given directory. Uses git apply.
 * Returns { success, stderr }.
 */
export async function applyPatch(
  cwd: string,
  patchContent: string,
): Promise<{ success: boolean; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args: ["apply", "--ignore-whitespace", "-"],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(patchContent));
  await writer.close();
  const result = await proc.output();
  return {
    success: result.success,
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Branch names we must never push to. */
const PROTECTED_BRANCHES = new Set(["main", "master"]);

/** Return true if branch is protected (e.g. main/master). */
export function isProtectedBranch(branchName: string): boolean {
  return PROTECTED_BRANCHES.has(branchName.trim().toLowerCase());
}
