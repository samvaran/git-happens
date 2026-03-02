# Releasing a new version

## Exact process (what actually happens)

A release is a **version bump + commit + tag + push**. After you push the tag, GitHub Actions does the rest (build, publish release, update Homebrew tap).

| Step | Who does it | What happens |
|------|-------------|--------------|
| 1. Set new version | You (or automation) | `deno.json` and `src/version.ts` get the new version (e.g. `1.2.0`). |
| 2. Commit | You (or automation) | Commit `deno.json` and `src/version.ts` with message like `Release v1.2.0`. |
| 3. Tag | You (or automation) | Create tag `v1.2.0` pointing at that commit. |
| 4. Push branch + tag | You (or automation) | `git push origin main` and `git push origin v1.2.0`. |
| 5. Build & release | **Release workflow** | Runs on tag push: builds all binaries, creates GitHub Release, uploads `dist/*`. |
| 6. Update Homebrew | **release-tap workflow** | Runs on release published: updates Formula in your tap (version + sha256). |

You only need to do steps 1–4. Steps 5–6 run in CI.

---

## Manual process (by hand)

```bash
# 1. Bump version (edit deno.json to e.g. "1.2.0", then sync)
deno task sync-version

# 2. Commit
git add deno.json src/version.ts
git commit -m "Release v1.2.0"

# 3. Tag
git tag v1.2.0

# 4. Push (replace main with your branch if different)
git push origin main
git push origin v1.2.0
```

After step 4, the **Release** and **release-tap** workflows run automatically.

---

## Automated options

### Option A: Local one-liner (recommended)

Use the **release** script to do steps 1–4 in one go. You can push immediately or review first.

```bash
# Bump to a specific version (or use patch / minor / major), commit, tag. No push yet.
deno task release -- 1.2.0

# Then push when ready:
git push origin main && git push origin v1.2.0
```

Or do it all in one shot:

```bash
# Bump patch (e.g. 1.2.0 -> 1.2.1), commit, tag, and push. Release + tap run in CI.
deno task release -- patch --push
```

**Tasks:**

- `deno task bump -- <version|patch|minor|major>` — only updates `deno.json` and `src/version.ts` (no git).
- `deno task release -- <version|patch|minor|major> [--push]` — bump + commit + tag; add `--push` to push and trigger the release.

### Option B: Bump only (then you git yourself)

```bash
deno task bump -- minor    # 1.2.0 -> 1.3.0
# or
deno task bump -- 2.0.0   # exact version

git add deno.json src/version.ts
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main && git push origin vX.Y.Z
```

### Option C: Release from GitHub (no local git)

If you prefer not to run git locally:

1. Open the repo on GitHub → **Actions**.
2. Select **Prepare release** in the left sidebar.
3. Click **Run workflow**.
4. Enter a version: either exact (e.g. `1.2.0`) or bump type (`patch`, `minor`, `major`).
5. Run the workflow.

It will bump, commit, tag, and push from the default branch. That triggers the **Release** workflow (build + publish) and then **release-tap** (Homebrew).

---

## What’s automated in CI (no extra work)

| Step | Workflow | When |
|------|----------|------|
| Lint / format | `ci.yml` | Every push and PR |
| Build binaries | `release.yml` | On push of tag `v*` |
| Create GitHub Release + upload assets | `release.yml` | Same run as above |
| Update Homebrew Formula (version + sha256) | `release-tap.yml` | When a release is published (needs `TAP_PAT` set) |

---

## Quick reference

| Goal | Command |
|------|--------|
| Bump and push a patch release | `deno task release -- patch --push` |
| Bump to exact version, then push yourself | `deno task release -- 1.2.0` then `git push origin main && git push origin v1.2.0` |
| Only bump (no commit) | `deno task bump -- minor` |
| Release from GitHub UI | Actions → Prepare release → Run workflow → enter version |

---

## Homebrew tap

If the repo has **TAP_PAT** (and optionally **TAP_REPO**) configured, the **release-tap** workflow updates your Homebrew Formula when a release is published. One-time setup: [docs/homebrew/README.md](homebrew/README.md).
