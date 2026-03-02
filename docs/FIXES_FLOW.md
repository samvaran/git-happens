# AI PR Fixes — Design

## Goal

Let the user select a PR (as in the review flow), fetch all reviews and review
comments via `gh`, then have the AI:

1. Read each comment and verify it's still valid (code may have changed).
2. Think about the **whole set** of comments: theme, larger-scale solutions vs
   local fixes.
3. Produce a **plan** and then **execute** (output a unified diff addressing the
   feedback).
4. Optionally disagree with comments when justified — make the right call for
   the codebase.

The user reviews the proposed edits; if they accept, we commit, push, and post
brief replies to each (top-level) comment saying what was addressed or why not.

## Flow

1. **Mode:** User selects "AI PR Fixes" at startup.
2. **PR selection:** Same as review flow — list PRs (assigned, review-requested,
   open, my PRs), pick one.
3. **Fetch context:** Via `gh`:
   - PR diff (`gh pr diff`)
   - PR metadata (title, body)
   - All reviews: `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` (body,
     state, author)
   - All review comments:
     `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` (id, path, line,
     body, diff_hunk, in_reply_to_id)
4. **Branch:** Ensure we're on the PR head branch (e.g.
   `gh pr checkout <number>` in that repo).
5. **AI:** Single prompt containing:
   - Instructions: read each comment, verify still valid, think about theme /
     larger solutions, be a good engineer, can disagree with feedback when
     right.
   - Full list of reviews (main body) and inline comments (with **comment_id**
     for replies).
   - Current diff (and optionally file contents if needed).
   - Output: `plan` (text), `diff` (unified diff to apply), `comment_replies`
     (array of `{ comment_id, body }` for top-level comments only).
6. **Apply:** Write the AI’s diff to a temp file, run `git apply` (or patch) in
   the repo. If apply fails, surface error and abort.
7. **Preview:** Run `git diff` / `git status`, show user the changes, ask to
   accept.
8. **Commit & push:** If accepted: `git add -A`, `git commit -m "..."`,
   `git push`. Commit message can be AI-generated or fixed (e.g. "Address PR
   review feedback").
9. **Replies:** For each top-level review comment, POST to
   `.../pulls/{pull_number}/comments/{comment_id}/replies` with body from
   `comment_replies` (or a default "Addressed in latest commit" if AI didn’t
   specify). Only top-level comments can be replied to per GitHub API.

## Principles in the system prompt

- Read each comment; verify it still applies to the current code.
- Think about the **larger problem**: What’s the theme? One refactor vs many
  small edits?
- Be a good engineer: clarity, maintainability, minimal unnecessary change.
- You don’t have to agree with every comment — consider, then decide what’s
  right for the project.
- Output a **plan** (short) and a **unified diff** that applies cleanly; plus
  brief **comment_replies** for reviewers.

## APIs used

| Action               | Endpoint / command                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------- |
| List reviews         | `GET .../pulls/{pull_number}/reviews`                                                    |
| List review comments | `GET .../pulls/{pull_number}/comments`                                                   |
| Reply to a comment   | `POST .../pulls/{pull_number}/comments/{comment_id}/replies` (body: `{ "body": "..." }`) |

Only **top-level** review comments can receive replies (not replies-to-replies).
