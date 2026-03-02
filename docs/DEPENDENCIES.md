# Dependency audit (pre-publish)

## Runtime dependencies

| Package                                                           | Version | License | Notes                          |
| ----------------------------------------------------------------- | ------- | ------- | ------------------------------ |
| [@cliffy/prompt](https://jsr.io/@cliffy/prompt) (select, confirm) | ^1.0.0  | MIT     | Interactive prompts; from JSR. |

That’s the only third-party code you import. Deno standard library and runtime
are used but not “dependencies” in the package sense.

## External tools (user’s environment)

- **gh** (GitHub CLI) – user must install and authenticate; we shell out.
- **AI CLI** (e.g. `claude`, `gemini`, `cursor`) – user must install; we shell
  out and pass prompt on stdin.

No bundled binaries; no npm/node. License choice for this repo only needs to be
compatible with **MIT** (Cliffy). **MIT** for git-happens is a good fit and
keeps things simple.
