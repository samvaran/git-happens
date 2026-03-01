# Versioning and releasing

## Where the version lives

- **Single source of truth:** `deno.json` → `"version": "1.0.0"`.
- **In the binary:** `src/version.ts` is generated from that (so the compiled CLI can show `--version`). It’s updated automatically when you run `deno task compile` or `deno task compile:all`, or manually with `deno task sync-version`.

Use **semver** (e.g. `1.0.0`, `1.1.0`, `2.0.0`). Bump in `deno.json` only; then sync and build.

---

## What’s automated (config in this repo)

| Step | Automated? | How |
|------|------------|-----|
| **Lint / format** | Yes | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on push and PRs: `deno lint`, `deno fmt --check`. |
| **Build binaries** | Yes | Triggered by pushing a tag `v*`. |
| **Create GitHub Release** | Yes | Same workflow: builds with `deno task compile:all`, then creates the release and uploads all `dist/*` assets. |
| **Version bump** | No | You edit `deno.json` and commit. |
| **Tag and push** | No | You run `git tag v1.0.0` and `git push origin v1.0.0`. |
| **Homebrew tap** | Yes (optional) | [`.github/workflows/release-tap.yml`](../.github/workflows/release-tap.yml): on release published, updates the Formula in your tap (version + sha256). Requires secret `TAP_PAT`; see [docs/homebrew/README.md](homebrew/README.md). |

So with the workflows in this repo you only need to: **bump version in `deno.json`**, **commit**, **tag** (e.g. `v1.1.0`), and **push the tag**. CI runs on every push/PR; the release workflow runs on tag push and does build + release + upload.

---

## Releasing a new version (manual steps)

1. **Bump version** in `deno.json` (e.g. `1.0.0` → `1.1.0`).

2. **Sync and commit** (so the tag has the right version in tree):
   ```bash
   deno task sync-version
   git add deno.json src/version.ts
   git commit -m "Release v1.1.0"
   ```

3. **Tag and push** (this triggers the release workflow):
   ```bash
   git tag v1.1.0
   git push origin main
   git push origin v1.1.0
   ```

4. The **release workflow** (`.github/workflows/release.yml`) will:
   - Check out the tag
   - Run `deno task compile:all` (versioned binaries in `dist/`)
   - Create a GitHub Release for that tag with generated release notes
   - Upload all `dist/*` binaries as release assets

5. **Homebrew tap:** If you set the `TAP_PAT` secret (token with write access to your tap repo), the [release-tap workflow](../.github/workflows/release-tap.yml) runs when a release is published. It clones your tap, updates `Formula/git-happens.rb` (version + sha256 of the source tarball), and pushes. One-time setup: create the tap repo, add the Formula from [docs/homebrew/Formula-git-happens.rb](homebrew/Formula-git-happens.rb), add `TAP_PAT`, and optionally set the `TAP_REPO` variable if your tap isn’t `{owner}/homebrew-tap`. See [docs/homebrew/README.md](homebrew/README.md).

## Quick reference

| Step | What to do |
|------|------------|
| Bump | Edit `version` in `deno.json`. |
| Sync + commit | `deno task sync-version`, then `git add deno.json src/version.ts` and commit. |
| Release | `git tag v1.1.0` and `git push origin v1.1.0` → workflow builds and publishes. |
| Homebrew | Automatic if `TAP_PAT` is set; else update Formula in tap by hand. See [docs/homebrew/README.md](homebrew/README.md). |
