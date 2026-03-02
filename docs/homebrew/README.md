# Homebrew tap automation

The workflow [`.github/workflows/release-tap.yml`](../../.github/workflows/release-tap.yml) updates your Homebrew tap when you publish a release.

## One-time setup

### 1. Create the tap repo

Create a repo named **`homebrew-git-happens`** under your GitHub org (e.g. `dvarka/homebrew-git-happens`). Add one file:

- **Path:** `Formula/git-happens.rb`
- **Content:** Copy from [Formula-git-happens.rb](Formula-git-happens.rb) and replace:
  - `YOUR_GITHUB_ORG` / `YOUR_REPO` with your repo (e.g. `dvarka` and `git-happens`).
  - Leave `version` and `sha256` as-is; the workflow will update them on each release.

### 2. Add a secret to the git-happens repo

In the **git-happens** repo: **Settings → Secrets and variables → Actions**:

- **Secret:** `TAP_PAT`  
  A Personal Access Token (or fine-grained token) with **write** access to the tap repo.  
  Create at: GitHub → Settings → Developer settings → Personal access tokens (scopes: `repo`, or fine-grained: contents read/write on the tap repo).

### 3. Tell the workflow which tap repo to use

In the **git-happens** repo: **Settings → Secrets and variables → Actions → Variables**:

- **Variable:** `TAP_REPO` = `dvarka/homebrew-git-happens`  
  (Use your org and the exact tap repo name. If you used `homebrew-tap` instead, you’d set `dvarka/homebrew-tap` and the tap command would be `brew tap dvarka/tap`.)

## What the workflow does

On **Release published** (after you push a tag and the release workflow runs):

1. Reads the release tag (e.g. `v1.1.0`) and computes the source tarball SHA256.
2. Clones the tap repo using `TAP_PAT`.
3. Updates `Formula/git-happens.rb`: sets `version` and `sha256`.
4. Commits and pushes to the tap.

Users run once: `brew tap dvarka/git-happens`, then `brew install git-happens` (or `brew update && brew upgrade git-happens` for upgrades).

## Skipping tap updates

If you don’t set the `TAP_PAT` secret, the tap job is skipped and releases still work; only the GitHub Release and assets are published.

## Troubleshooting

- **Tap doesn’t update after a release**  
  - Check **Actions** in the **git-happens** repo: did **“Update Homebrew tap”** run? If it’s missing, the job is skipped because `TAP_PAT` isn’t set — add the secret.  
  - If the job ran but the Formula didn’t change: the workflow defaults to `{org}/homebrew-git-happens`. If your tap repo has a different name, set the **`TAP_REPO`** variable (e.g. `dvarka/homebrew-git-happens`).

- **Formula `url` must point at the app repo**  
  The tarball Homebrew downloads is the **git-happens** source (the app), not the tap repo. In the Formula, `url` and `homepage` should use **`dvarka/git-happens`**, not `dvarka/homebrew-git-happens`.
