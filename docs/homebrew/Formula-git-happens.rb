# Copy this file to your Homebrew tap as Formula/git-happens.rb.
# Replace YOUR_GITHUB_ORG and YOUR_REPO with your GitHub org/user and repo (e.g. myuser/git-happens).
# The release-tap workflow updates only "version" and "sha256" when you publish a release.

class GitHappens < Formula
  desc "AI-powered PR reviews from the CLI"
  homepage "https://github.com/YOUR_GITHUB_ORG/YOUR_REPO"
  version "0.0.1"
  url "https://github.com/YOUR_GITHUB_ORG/YOUR_REPO/archive/refs/tags/v#{version}.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "deno"

  def install
    system "deno", "task", "compile"
    bin.install "git-happens"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/git-happens --version").strip
  end
end
