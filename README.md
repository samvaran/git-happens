# Git Happens

AI-powered PR reviews from the CLI: list PRs (assigned or review-requested), pick one, run an AI review using your existing CLI (Claude, Cursor, Gemini), and submit the result to GitHub with optional inline comments.

**Stack:** Deno + [Cliffy](https://cliffy.io/) prompts. Single-binary distribution via `deno compile`. **License:** [MIT](LICENSE).

## Prerequisites

- [Deno](https://deno.land/) (for development) or a pre-built binary
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- (Optional) An AI CLI that accepts a prompt on stdin and returns JSON on stdout. Choose it with a flag: `--claude`, `--gemini`, or `--cursor` (default: `--claude`). If the binary is missing, the app shows a stub review and still demonstrates the flow.

## Run (development)

```bash
deno task run              # uses Claude by default
deno task run -- --gemini  # use Gemini
deno task run -- --cursor  # use Cursor
```

Or with permissions explicitly:

```bash
deno run --allow-read --allow-net --allow-run src/main.ts --claude
```

## Build a single executable

From the project root:

```bash
# Current platform only (output: git-happens or git-happens.exe)
deno task compile

# All supported targets into dist/ (versioned filenames, e.g. git-happens-1.0.0-arm64-macos)
deno task compile:all
```

The version comes from `deno.json` and is synced into the binary (e.g. `git-happens --version`). See [docs/RELEASING.md](docs/RELEASING.md) for how to bump and release.

Required permissions are baked in at compile time: `--allow-read`, `--allow-net`, `--allow-run` (for `gh` and the AI CLI).

## Flow

1. Fetches PRs assigned to you, then PRs where you’re requested for review.
2. You pick one from an interactive list (searchable).
3. Fetches the diff (`gh pr diff`) and PR metadata.
4. Runs the AI CLI with a built-in prompt; expects a JSON review (summary, verdict, inline_comments).
5. Shows the review and asks for confirmation.
6. Submits via `gh api` (GitHub REST: body + optional inline comments).

## How the AI review works (CLI as API)

We don’t call an HTTP API. The app **spawns your AI CLI** (e.g. `claude`) as a subprocess:

1. Builds one big prompt (instructions + PR title/body + full diff).
2. **Writes that prompt to the CLI’s stdin** and waits.
3. The CLI talks to the model (auth, API keys, etc. are the CLI’s job).
4. **Reads the model’s reply from stdout**, parses the JSON (summary, verdict, inline comments), and maps it to GitHub’s review payload.

So the CLI is used like an API: text in → text out. When you run the review, you’ll see progress lines (sending prompt, waiting, parsing) so you can tell what’s happening.

## Configuration

- **AI backend:** Pass `--claude`, `--gemini`, or `--cursor` to choose which CLI is invoked (default: `--claude`). The app runs that binary with the prompt on stdin and parses JSON from stdout.
- **Repo:** Run from any directory; the app uses the PR’s repo for diff and submit. Picked PRs always include repo info.

## Docs

- [RELEASING.md](docs/RELEASING.md) — Versioning, release steps, automation.
- [DEPENDENCIES.md](docs/DEPENDENCIES.md) — Dependency audit and licenses.
- [Homebrew tap](docs/homebrew/README.md) — One-time setup so the tap Formula updates automatically on release.
- [PLAN.md](docs/PLAN.md) — Overall plan, GitHub API, options.
- [DENO.md](docs/DENO.md) — Deno platform, `deno compile`, Cliffy vs deno_tui.
- [TEXTUAL.md](docs/TEXTUAL.md) — Alternative Python/Textual design.
