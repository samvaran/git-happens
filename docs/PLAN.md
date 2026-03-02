# Git Happens — AI Code Review CLI: Plan & Options

A command-line app that lists PRs (assigned to you / open for review in your
orgs), lets you pick one, runs an AI review using your existing AI CLI (Claude,
Cursor, Gemini), and submits the result as a GitHub review (body + inline
comments + approve/request changes/comment).

---

## 1. Core flow

1. **List PRs** — Show PRs assigned to you and/or open for review (optionally
   scoped by org).
2. **Pick one** — Interactive selection (e.g. list + fuzzy find).
3. **Fetch diff** — Same diff as GitHub web UI via `gh pr diff <number>`.
4. **Run AI** — Call your chosen AI CLI with diff + built-in prompt; get
   structured review (summary + inline comments + verdict).
5. **Submit review** — Post to GitHub using `gh api` (and optionally
   `gh pr review` for body-only cases).

---

## 2. GitHub review submission

### Native `gh pr review` (body only)

- **Command:**
  `gh pr review [<number>] --approve | --comment | -r --request-changes -b "<body>"`
- **Limitation:** No inline comments; only top-level body and event type.
- **Use when:** We only have a summary and no line-level comments.

### Full review (body + inline comments) via REST

- **Endpoint:** `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
- **Invoke via:**
  `gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews -f event=APPROVE -f body="..." --input - < review.json`
  or by building the full JSON and passing it.
- **Request body (relevant fields):**
  - `event`: `"APPROVE"` | `"REQUEST_CHANGES"` | `"COMMENT"`
  - `body`: string (required for REQUEST_CHANGES and COMMENT; optional for
    APPROVE)
  - `comments`: array of:
    - `path`: file path (required)
    - `body`: comment text (required)
    - **Location** (one of):
      - `position`: 1-based index of the line in the **unified diff** (from
        first `@@` in that file). Fragile if diff changes.
      - **Preferred:** `line`, `side` (`"LEFT"` | `"RIGHT"`), and optionally
        `start_line` / `start_side` for multi-line.
  - `commit_id`: optional; omit to use PR’s latest commit.

So the app should output an **internal JSON** that we convert (if needed) into
this REST payload and send with `gh api`. There is no separate “gh review JSON
file format”; we use the GitHub REST API shape.

**Reference:**
[GitHub REST: Create a review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request).

### Alternative: `gh-pr-review` extension (GraphQL)

- **Repo:** [agynio/gh-pr-review](https://github.com/agynio/gh-pr-review)
- **Capabilities:** Start pending review → add inline comments by path/line →
  submit with event/body. Uses GraphQL; returns structured JSON; good for
  agents.
- **Options:** (a) Depend on this extension and drive it from our app, or (b)
  Implement submission ourselves via `gh api` (REST) for no extra installs.
  Recommendation: start with **REST via `gh api`** so the app only requires
  `gh`; we can add optional integration with `gh-pr-review` later.

---

## 3. Getting PR lists and diffs

| Need                                      | Command / approach                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRs assigned to you (current repo)        | `gh pr list --assignee "@me"`                                                                                                                                                                  |
| PRs where you’re requested (current repo) | `gh pr list --search "user-review-requested:@me"` or `review-requested:@me`                                                                                                                    |
| PRs across an org                         | `gh search prs --state open org:<org>` (and optionally `review-requested:@me` in query if supported); or iterate repos with `gh repo list <org> --limit N` then `gh pr list -R owner/repo ...` |
| Diff (same as GitHub UI)                  | `gh pr diff <number>` (or `-R owner/repo <number>`); output is unified diff.                                                                                                                   |

For “PRs open for review in orgs you’re part of,” we can:

- Use `gh search prs` with `org:<org>` and search qualifiers, and/or
- Use `gh api user/orgs` to get orgs, then for each org either
  `gh search prs org:<org> ...` or list repos and then PRs per repo.

---

## 4. Interactive CLI stack (options)

Goal: “Beautiful” interactive CLI (list, select, maybe filters). Below are solid
options that often show up in HN-style demos.

### Option A: Go + Charm (Bubble Tea / Bubbles / Lipgloss)

- **Bubble Tea** — TUI framework (Elm-like; model/update/view).
  [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) (~31k
  stars).
- **Bubbles** — Components (list, textinput, viewport, etc.).
  [charmbracelet/bubbles](https://github.com/charmbracelet/bubbles).
- **Lipgloss** — Styling (colors, borders, layout).
  [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss).
- **Pros:** Single binary, fast, very polished TUIs, great for “pick from list +
  optional filters.” Fits well with `gh` (also Go).
- **Cons:** Need to implement subprocess calls to `gh` and AI CLIs; no built-in
  “run shell and parse output” widgets.

### Option B: Node.js + Inquirer / @inquirer/prompts

- **Inquirer.js** or **@inquirer/prompts** — Prompts (list, checkbox, confirm,
  input). Supports select lists, pagination, themes.
- **Pros:** Quick to build; easy to spawn `gh` and AI CLI and parse
  JSON/streaming output; huge ecosystem.
- **Cons:** Requires Node; less “full TUI” than Charm (more prompt-by-prompt
  than one persistent screen).

### Option C: Python + Textual / Rich ✓ (explored)

- **Textual** — Full TUI framework (reactive, widgets).
  [Textualize/textual](https://github.com/Textualize/textual).
- **Rich** — Rich console output (tables, panels, syntax).
  [Textualize/rich](https://github.com/Textualize/rich).
- **Pros:** Great for tables (e.g. PR list with number, title, repo, author);
  Rich is ideal for printing the diff or AI output before submit. Workers API
  for running `gh`/AI CLI without blocking UI; screens for list → review →
  confirm flow; ModalScreen for “Submit?” dialog.
- **Cons:** Python runtime; subprocess and JSON handling are fine but slightly
  more boilerplate than Node for “call CLI and parse.”
- **Deep dive:** See [TEXTUAL.md](TEXTUAL.md) for how DataTable, Screens,
  Workers, and ModalScreen map to this app.

### Option D: Rust + ratatui (or crossterm)

- **ratatui** — TUI crate (list, table, etc.). Very performant and
  “terminal-native.”
- **Pros:** Single binary, fast, modern.
- **Cons:** More setup and lower-level than Charm; smaller ecosystem for “prompt
  and run external CLI” flows.

### Option E: Deno + Cliffy / deno_tui ✓ (platform choice)

- **Platform:** [Deno](https://deno.land/) — TypeScript by default, **built-in
  compiler** for distribution.
- **Distribution:** `deno compile` produces a **single executable** (no
  Deno/Node install for users). Cross-compile with `--target`. Permissions
  (`--allow-read`, `--allow-net`, `--allow-run`) are set at compile time.
- **UI options:**
  - **Cliffy** — Prompts: `Select` (pick PR), `Confirm` (submit?), `Table`
    (print PR list). Step-by-step, quick to ship.
  - **deno_tui** — Full TUI (table + panels, one screen). More “HN-style” but
    more code.
- **Pros:** One binary to ship; TypeScript; `Deno.Command` for `gh` and AI CLI;
  Cliffy gives a clean list → pick → confirm flow.
- **Cons:** Smaller ecosystem than Node for TUIs; deno_tui less battle-tested
  than Charm/Textual.
- **Deep dive:** See [DENO.md](DENO.md) for compiler usage, Cliffy vs deno_tui,
  and invoking `gh`/AI.

### Recommendation (for “beautiful interactive” + HN vibe)

- **Deno + Cliffy** (platform choice) — Single binary via `deno compile`;
  TypeScript; Cliffy Select/Confirm for list → pick → confirm. See
  [DENO.md](DENO.md).
- **Go + Charm** if you want a single binary and full TUI (one screen,
  keyboard-driven) with maximum polish.
- **Node + @inquirer/prompts** if you want to ship fast with a clean “list →
  pick → run → confirm” flow and don’t need a single persistent TUI.
- **Python + Textual + Rich** if you prefer Python and want a rich table view of
  PRs plus pretty-printed diff/review.

---

## 5. AI integration (Claude / Cursor / Gemini CLI)

- **Idea:** Don’t implement AI ourselves; **invoke the user’s existing CLI**
  (e.g. Claude CLI, Cursor CLI, or Gemini CLI).
- **Flow:**
  1. Build a single prompt (or a few variants): PR title/description + full diff
     (or chunked) + instructions.
  2. Instructions should ask for a **structured output** (e.g. JSON):
     `{ "summary": "...", "verdict": "approve"|"request_changes"|"comment", "inline_comments": [ { "path": "...", "line": N, "side": "RIGHT", "body": "..." } ] }`.
  3. Run the AI CLI (e.g. `claude ...`, or whatever Cursor/Gemini expose) with
     this prompt (stdin or temp file).
  4. Parse stdout (or a file) for the JSON; validate and map to GitHub’s
     `event` + `body` + `comments` (and `line`/`side`/`path`).

**Options to support (discovery + invocation):**

| Provider        | CLI / binary                    | How we’d call it                              | Notes                                                             |
| --------------- | ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Anthropic       | `claude` (or official CLI name) | Subprocess with prompt on stdin; read stdout  | Need to confirm exact CLI name and flags for “one response” mode. |
| Cursor          | Depends (e.g. `cursor` or API)  | TBD: CLI for headless completion vs in-editor | May need to detect and document “run from terminal” usage.        |
| Google (Gemini) | e.g. `gemini` or `gcloud ai`    | Same pattern: stdin/stdout or file            | Check actual CLI for non-interactive, JSON-friendly output.       |

We should make the **AI backend pluggable** (e.g. config or env: `AI_CLI=claude`
/ `cursor` / `gemini` and optional path), and document required CLI behavior
(accept prompt, return one blob of text we can parse as JSON).

---

## 6. Built-in prompt and evaluation “dimensions”

You want the PR evaluated “in a few different ways.” Those dimensions can be
reflected in the **single structured output** so the model returns one JSON that
includes:

- **Summary** — Short overall assessment (→ review `body`).
- **Verdict** — `approve` | `request_changes` | `comment` (→ `event`).
- **Inline comments** — Array of `path`, `line`, `side`, `body` (→ `comments`).
- **Optional dimensions** (can be in the same JSON or separate keys): e.g.
  “correctness,” “security,” “style,” “tests,” “docs.” We can either:
  - Ask the model to score or briefly comment per dimension and fold that into
    the summary, or
  - Have a short “dimensions” object in the JSON and we format it into the
    `body` (e.g. “**Correctness:** … **Security:** …”).

So the “evaluate in a few different ways” is mostly **prompt design**: one
prompt that asks for that structure (and optionally dimension-wise bullets); no
need for multiple API calls unless we later add “run N prompts and merge.”

---

## 7. Output format (our schema → GitHub)

We don’t need a special “gh JSON format”; we need an **internal schema** that we
then map to the GitHub REST body.

**Proposed internal schema (what the AI is asked to produce):**

```json
{
  "summary": "Overall review text (markdown) for the review body",
  "verdict": "approve | request_changes | comment",
  "inline_comments": [
    {
      "path": "src/foo.go",
      "line": 42,
      "side": "RIGHT",
      "body": "Suggest using X here."
    }
  ]
}
```

Optional: `start_line`, `start_side` for multi-line; optional `dimensions`
object for the “evaluate in different ways” text we merge into `summary`.

**Mapping to GitHub API:**

- `event` ← `verdict` (approve → APPROVE, request_changes → REQUEST_CHANGES,
  comment → COMMENT).
- `body` ← `summary` (and optionally formatted dimensions).
- `comments` ← each element: `path`, `body`, `line`, `side` (and
  `start_line`/`start_side` if present). We do **not** send `position` if we
  have `line`/`side` (GitHub recommends line/side).

If the AI only returns a summary and no inline comments, we can still submit via
`gh pr review ...` for simplicity, or always use `gh api .../reviews` with an
empty `comments` array.

---

## 8. Suggested project layout (high level)

- **Config:** Config file or env for: default org(s), AI provider
  (claude/cursor/gemini), CLI path, and optionally prompt overrides.
- **Commands (examples):**
  - `list` — PRs assigned to you + open for review (current repo and/or orgs);
    output for TUI or as table.
  - `review [PR]` — If PR not given, show interactive list; then fetch diff, run
    AI, show proposed review, confirm, submit.
  - `diff <PR>` — Just fetch and show diff (useful for debugging).
- **Modules:**
  - GitHub (list PRs, get diff, submit review via `gh`).
  - AI (build prompt, call CLI, parse JSON).
  - Prompt (built-in prompt + optional dimension template).
  - UI (list + select + confirm; depends on chosen stack).

---

## 9. Open decisions

| Topic                       | Options                                                                           | Suggestion                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Language / framework**    | Deno+Cliffy, Deno+deno_tui, Go+Charm, Node+Inquirer, Python+Textual, Rust+ratatui | **Deno+Cliffy** for single-binary distribution (`deno compile`) + TypeScript + simple prompt flow; see [DENO.md](DENO.md). |
| **Review submission**       | Only `gh pr review` (body) vs always `gh api` (body + inline)                     | Prefer **always `gh api`** so one code path and we support inline comments when the AI returns them.                       |
| **PR scope**                | Current repo only vs org(s) vs “all my orgs”                                      | Start with **current repo** + optional `--org`; add “all my orgs” later.                                                   |
| **AI backends**             | Claude only vs multiple (Claude, Cursor, Gemini)                                  | Design for **multiple** with a small adapter per CLI.                                                                      |
| **Inline comment location** | `position` (diff line index) vs `line`+`side`                                     | Prefer **line + side**; we may need to derive from diff or from PR file view API if the AI returns “file + line” only.     |

---

## 10. Next steps

1. **Stack chosen:** Deno + Cliffy (or deno_tui for full TUI). Confirm you have
   one of the AI CLIs installed. See [DENO.md](DENO.md) for compile and UI
   options.
2. **Implement “list PRs”** using `gh pr list` / `gh search prs` and render in
   the chosen UI.
3. **Implement “get diff”** with `gh pr diff` and (if needed) “get PR metadata”
   (title, body) for the prompt.
4. **Design and hardcode one prompt** that requests the internal JSON (summary,
   verdict, inline_comments, optional dimensions).
5. **Implement one AI adapter** (e.g. Claude CLI): subprocess, pass prompt,
   parse JSON.
6. **Implement submit:** build GitHub REST body from internal JSON, call
   `gh api repos/.../pulls/.../reviews` (and handle `line`/`side` vs `position`
   if needed).
7. **Wire up:** list → select PR → diff → AI → show review → confirm → submit.
8. **Add** other AI backends and org-wide PR listing as needed.

Next step: concrete repo layout and one command flow for **Deno + Cliffy** (e.g.
`main.ts`, `gh.ts`, `ai.ts`, prompts), plus a `deno compile` script for
distribution.
