# Deno as platform — distribution & UI options

Deno is a strong fit for this CLI: **TypeScript by default**, **built-in
compiler** for single-file distribution, and no separate runtime needed for end
users.

---

## Why Deno for distribution

### `deno compile` — single executable

- **Command:** `deno compile [OPTIONS] [SCRIPT]`
- **Result:** A **self-contained executable** that bundles your code + a slim
  Deno runtime. No Deno install required for users.
- **Permissions:** Pass `--allow-read`, `--allow-net`, `--allow-run` (for
  calling `gh` and the AI CLI) at **compile time**; they’re baked into the
  binary.
- **Cross-compile:** Use `--target` to build for other OS/arch from one machine.

```bash
# Build for current platform
deno compile --allow-read --allow-net --allow-run -o git-happens main.ts

# Cross-compile (e.g. macOS ARM from Linux)
deno compile --target aarch64-apple-darwin --allow-read --allow-net --allow-run -o git-happens main.ts
```

**Supported targets:** `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`,
`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.

- **Optional:** `--include <file>` to embed data files (e.g. default prompt);
  `--icon` on Windows for a custom .ico.
- **Docs:** [Deno manual — Compiler](https://deno.land/manual/tools/compiler)

So: one `deno compile` (or a small script that compiles per target) gives you a
single binary to ship; users run it without installing Deno or Node.

---

## UI options on Deno

Two main styles: **prompt-based** (step-by-step) vs **full TUI** (single screen,
keyboard-driven).

### 1. Cliffy — prompts (recommended for “list → pick → confirm”)

- **What:** Command-line framework with **interactive prompts**: Select,
  Confirm, Input, etc.
- **Import:** `jsr:@cliffy/prompt` or
  `https://deno.land/x/cliffy@v0.24.2/prompt/mod.ts`
- **Select:** List of options with arrow keys + Enter; supports search,
  pagination, disabled items.

```ts
import { Select } from "jsr:@cliffy/prompt";

const pr = await Select.prompt({
  message: "Pick a PR to review",
  options: prs.map((p) => ({ name: `#${p.number} ${p.title}`, value: p })),
  search: true,
  maxRows: 10,
});
// pr = selected item (e.g. { number, title, repo, ... })
```

- **Confirm:** “Submit this review?” Yes/No.
- **Flow:** List PRs (run `gh` → parse JSON) → `Select.prompt` → fetch diff →
  run AI → show review → `Confirm.prompt` → submit via `gh api`.
- **Pros:** Simple, fast to build, no full-screen TUI complexity. One question
  at a time.
- **Cons:** Not a single persistent “table” screen; feels more wizard than
  dashboard.

**Docs:** [cliffy.io](https://cliffy.io/) — Prompt, Select, Confirm, Table (for
printing PR list as table).

### 2. deno_tui (x/tui) — full TUI

- **What:** TUI library for Deno: components (buttons, text boxes, etc.),
  keyboard/mouse, reactive updates.
- **Import:** `https://deno.land/x/tui@2.1.11/mod.ts` (or latest).
- **Use case:** One screen with a table/list of PRs, then navigate to a “review”
  view, then a confirm dialog — closer to the Textual/Charm style.
- **Pros:** Single persistent UI, table + panels, “HN-style” TUI.
- **Cons:** More code and structure than Cliffy; fewer examples than Node/Go
  TUIs.

**Docs:** [deno.land/x/tui](https://deno.land/x/tui),
[Creating a Universal TUI Application with Deno Tui](https://developer.mamezou-tech.com/en/blogs/2023/11/03/deno-tui/).

---

## Recommendation for Git Happens

- **Distribution:** Use **Deno** and **`deno compile`** for a single binary per
  platform; document required permissions (`--allow-read`, `--allow-net`,
  `--allow-run`).
- **UI:** Start with **Cliffy** (Select + Confirm + Table) for a quick, clear
  flow: list PRs → pick one → show diff/review → confirm submit. If you later
  want a single-screen table and richer UX, add or switch to **deno_tui**.

---

## Invoking `gh` and the AI CLI from Deno

- **Subprocess:**
  `new Deno.Command("gh", { args: ["pr", "list", "--assignee", "@me", "--json", "number,title,author"] }).output()`
  then decode stdout.
- **JSON:** `gh pr list --json ...` and `gh pr view <n> --json ...` return JSON;
  parse with `JSON.parse(new TextDecoder().decode(output.stdout))`.
- **AI CLI:** Same pattern:
  `Deno.Command("claude", { args: [...], stdin: "piped", stdout: "piped" })`,
  write prompt to stdin, read stdout, parse JSON review from the model output.

Permissions: `--allow-run` is required for both `gh` and the AI CLI when using
`Deno.Command`.

---

## Summary

| Topic             | Choice / note                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Platform**      | Deno (TypeScript, single-binary via `deno compile`)                                                               |
| **Distribution**  | `deno compile --allow-read --allow-net --allow-run -o git-happens main.ts`; optional `--target` for cross-compile |
| **UI (simple)**   | Cliffy: Select (PR list), Confirm (submit), Table (print PRs)                                                     |
| **UI (full TUI)** | deno_tui for one-screen table + panels                                                                            |
| **gh / AI**       | `Deno.Command` with `--allow-run`                                                                                 |
