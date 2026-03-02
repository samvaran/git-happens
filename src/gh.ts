import type {
  GitHubReviewPayload,
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
  const args = ["pr", "list", "--json", "number,title,author,headRefName,baseRefName,url"];
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
  const sectionPriority: (typeof assigned)[0]["section"][] = ["assigned", "review_requested", "my_prs", "open_other"];
  for (const list of [assigned, reviewRequested, myPrs, involvesMe]) {
    for (const p of list) {
      const key = p.repository ? `${p.repository.nameWithOwner}#${p.number}` : "";
      if (!key) continue;
      const existing = byKey.get(key);
      const existingPri = existing ? sectionPriority.indexOf(existing.section!) : 99;
      const newPri = sectionPriority.indexOf(p.section!);
      if (!existing || newPri < existingPri) byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

async function listPrsViaSearchSection(
  section: "assigned" | "review_requested" | "open_other" | "my_prs"
): Promise<PRListItem[]> {
  const flag =
    section === "assigned"
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
      .filter((p): p is SearchPRItem & { repository: { nameWithOwner: string } } =>
        Boolean(p.repository?.nameWithOwner))
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
export async function fetchPrSizes(prs: PRListItem[], batchSize = 10): Promise<void> {
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
          const data = JSON.parse(raw) as { additions?: number; deletions?: number };
          p.additions = data.additions ?? 0;
          p.deletions = data.deletions ?? 0;
        } catch {
          p.additions = 0;
          p.deletions = 0;
        }
      })
    );
  }
}

/** Get PR diff (same as GitHub web UI). */
export async function getDiff(prNumber: number, repo?: string): Promise<string> {
  const args = ["pr", "diff", String(prNumber)];
  if (repo) args.push("-R", repo);
  return gh(args);
}

/** Get PR title and body for the prompt (optional). */
export async function getPrMeta(
  prNumber: number,
  repo?: string
): Promise<{ title: string; body: string }> {
  const args = ["pr", "view", String(prNumber), "--json", "title,body"];
  if (repo) args.push("-R", repo);
  const raw = await gh(args);
  const data = JSON.parse(raw) as { title: string; body: string };
  return { title: data.title ?? "", body: data.body ?? "" };
}

/** Resolve owner/repo from current directory (e.g. for gh api). */
export async function getRepo(): Promise<{ owner: string; repo: string } | null> {
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

/** Run git in repo root; returns stdout. Throws on non-zero exit. */
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
export async function getCurrentBranchPr(repoSlug: string): Promise<{ number: number; title: string; url: string } | null> {
  try {
    const raw = await gh(["pr", "view", "-R", repoSlug, "--json", "number,title,url"]);
    const data = JSON.parse(raw) as { number: number; title?: string; url?: string };
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
  pullNumber: number
): Promise<string> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}`;
  const raw = await gh(["api", path, "-q", ".head.sha"]);
  return raw.trim();
}

/** Submit a review via GitHub REST API (gh api). */
export async function submitReview(
  owner: string,
  repo: string,
  pullNumber: number,
  payload: GitHubReviewPayload
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  await gh(["api", path, "--input", "-"], JSON.stringify(payload));
}

/** Open a URL in the default browser. */
export function openInBrowser(url: string): void {
  const cmd = Deno.build.os === "windows" ? "start" : Deno.build.os === "darwin" ? "open" : "xdg-open";
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
  pullNumber: number
): Promise<PrReview[]> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const raw = await gh(["api", path, "--paginate"]);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map((r: { id: number; body?: string | null; state?: string; user?: { login?: string } }) => ({
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
  userLogin: string
): Promise<{ id: number } | null> {
  const reviews = await getPrReviews(owner, repo, pullNumber);
  const pending = reviews.find((r) => r.state === "PENDING" && r.user?.login === userLogin);
  return pending ? { id: pending.id } : null;
}

/** Delete a pending (draft) review. Use before posting a new draft if replacing. */
export async function deletePendingReview(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`;
  await gh(["api", path, "-X", "DELETE"]);
}

/** Fill userHasPendingReview and pendingReviewId for each PR. Mutates items in place. Batched. */
export async function fetchPendingReviewStatus(
  prs: PRListItem[],
  currentUserLogin: string,
  batchSize = 8
): Promise<void> {
  const withRepo = prs.filter((p) => p.repository?.nameWithOwner);
  for (let i = 0; i < withRepo.length; i += batchSize) {
    const batch = withRepo.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (p) => {
        const repo = p.repository!.nameWithOwner;
        const [owner, repoName] = repo.split("/");
        try {
          const pending = await getPendingReview(owner, repoName, p.number, currentUserLogin);
          (p as PRListItem).userHasPendingReview = pending != null;
          (p as PRListItem).pendingReviewId = pending?.id;
        } catch {
          (p as PRListItem).userHasPendingReview = false;
        }
      })
    );
  }
}

/** List all review comments (inline) for a PR. */
export async function getPrReviewComments(
  owner: string,
  repo: string,
  pullNumber: number
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
    })
  );
}

/** True if the PR has any review body or inline comments (something to address). */
export async function prHasReviewFeedback(
  owner: string,
  repo: string,
  pullNumber: number
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
    })
  );
  return withSection;
}

/** Reply to a top-level review comment. */
export async function replyToReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string
): Promise<void> {
  const path = `repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`;
  await gh(["api", path, "-X", "POST", "--input", "-"], JSON.stringify({ body }));
}
