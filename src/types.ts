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
  section?:
    | "assigned"
    | "review_requested"
    | "open_other"
    | "my_prs"
    | "fixes_has_feedback"
    | "fixes_other";
  /** True if the current user has a pending (draft) review on this PR. Filled by fetchPendingReviewStatus. */
  userHasPendingReview?: boolean;
  /** When userHasPendingReview, the review id (for replace/delete). */
  pendingReviewId?: number;
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

/** GitHub API review payload (POST .../pulls/{pull_number}/reviews). Omit event for draft (PENDING). */
export interface GitHubReviewPayload {
  event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
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

// --- AI PR Fixes flow ---

/** One PR review (main body, not inline). From gh api .../pulls/{n}/reviews */
export interface PrReview {
  id: number;
  body: string | null;
  state: string;
  user?: { login?: string } | null;
}

/** One inline review comment. From gh api .../pulls/{n}/comments */
export interface PrReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  side?: "LEFT" | "RIGHT";
  diff_hunk?: string;
  in_reply_to_id?: number | null;
  user?: { login?: string } | null;
}

/** AI output for the fixes flow: plan, patch, and replies to comments */
export interface FixesResult {
  plan: string;
  /** Unified diff to apply (e.g. from `diff -u` or AI-generated). */
  diff: string;
  /** Brief reply for each top-level comment (key = comment id as number or string). */
  comment_replies?: Array< { comment_id: number; body: string } >;
  /** Optional commit message; otherwise we use a default. */
  commit_message?: string;
}
