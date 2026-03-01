import type { GitHubReviewPayload, PRListItem } from "./types.ts";

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
