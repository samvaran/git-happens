/** Pull request summary from `gh pr list --json ...` or `gh search prs --json ...` */
export interface PRListItem {
  number: number;
  title: string;
  author: { login: string };
  headRefName?: string;
  baseRefName?: string;
  url?: string;
  /** owner/repo when from search or -R; used for diff/view/submit */
  repository?: { nameWithOwner: string };
  /** Filled by fetchPrSizes; used for display and sort */
  additions?: number;
  deletions?: number;
  /** Section grouping for the picker */
  section?: "assigned" | "review_requested" | "open_other" | "my_prs";
}

/** Internal review result we ask the AI to produce (and map to GitHub API) */
export interface ReviewResult {
  summary: string;
  verdict: "approve" | "request_changes" | "comment";
  inline_comments?: InlineComment[];
}

export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

/** GitHub API review payload (POST .../pulls/{pull_number}/reviews) */
export interface GitHubReviewPayload {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments?: GitHubReviewComment[];
  commit_id?: string;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}
