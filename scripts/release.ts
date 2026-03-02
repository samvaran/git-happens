/**
 * Bump version, commit, and tag. Optionally push (triggers CI release + Homebrew tap).
 * Usage:
 *   deno task release -- 1.2.3           # bump to 1.2.3, commit, tag (no push)
 *   deno task release -- patch --push   # bump patch, commit, tag, push
 *   deno task release -- minor          # bump minor, commit, tag only
 */
const root = new URL("..", import.meta.url).pathname;
const doPush = Deno.args.includes("--push");
const args = Deno.args.filter((a) => a !== "--push" && a !== "--");
const versionArg = args[0];

if (!versionArg) {
  console.error(
    "Usage: deno task release -- <version|patch|minor|major> [--push]",
  );
  Deno.exit(1);
}

async function run(cmd: string[], opts?: { cwd?: string }): Promise<boolean> {
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts?.cwd ?? root,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return status.success;
}

// 1. Bump (updates deno.json + src/version.ts)
const bump = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-read",
    "--allow-write",
    `${root}scripts/bump.ts`,
    versionArg,
  ],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (!(await bump.spawn().status).success) Deno.exit(1);

// 2. Read new version for commit/tag
const j = JSON.parse(await Deno.readTextFile(`${root}deno.json`)) as {
  version: string;
};
const version = j.version;

// 3. Git add, commit, tag
const branch = await new Deno.Command("git", {
  args: ["rev-parse", "--abbrev-ref", "HEAD"],
  cwd: root,
  stdout: "piped",
}).output().then((o) => new TextDecoder().decode(o.stdout).trim());

if (!(await run(["git", "add", "deno.json", "src/version.ts"]))) Deno.exit(1);
if (!(await run(["git", "commit", "-m", `Release v${version}`]))) Deno.exit(1);
if (!(await run(["git", "tag", `v${version}`]))) Deno.exit(1);

console.log(`\nCommitted and tagged v${version}.`);

if (doPush) {
  console.log(`Pushing ${branch} and v${version}...`);
  if (!(await run(["git", "push", "origin", branch]))) Deno.exit(1);
  if (!(await run(["git", "push", "origin", `v${version}`]))) Deno.exit(1);
  console.log(
    "Done. Release workflow will build and publish; tap will update if TAP_PAT is set.",
  );
} else {
  console.log(
    `To publish, run:\n  git push origin ${branch} && git push origin v${version}`,
  );
}
