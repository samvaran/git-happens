/**
 * Bump version in deno.json (and sync to src/version.ts).
 * Usage:
 *   deno task bump -- 1.2.3     # set exact version
 *   deno task bump -- patch     # 1.2.3 -> 1.2.4
 *   deno task bump -- minor     # 1.2.3 -> 1.3.0
 *   deno task bump -- major     # 1.2.3 -> 2.0.0
 */
const root = new URL("..", import.meta.url).pathname;
const denoJsonPath = `${root}deno.json`;

const arg = Deno.args[0];
if (!arg) {
  console.error("Usage: deno run scripts/bump.ts <version|patch|minor|major>");
  Deno.exit(1);
}

const j = JSON.parse(await Deno.readTextFile(denoJsonPath)) as { version?: string };
const current = j.version ?? "0.0.0";

function nextVersion(bump: string): string {
  const parts = current.split(".").map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      return arg; // treat as exact version
  }
}

const version = /^(patch|minor|major)$/i.test(arg) ? nextVersion(arg.toLowerCase()) : arg;

// basic semver check
if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  Deno.exit(1);
}

j.version = version;
await Deno.writeTextFile(denoJsonPath, JSON.stringify(j, null, 2) + "\n");

// sync to src/version.ts
const versionTs = `/** Synced from deno.json by scripts/compile.ts (or deno task sync-version). Single source of truth: deno.json "version". */
export const VERSION = "${version}";
`;
await Deno.writeTextFile(`${root}src/version.ts`, versionTs);

console.log(`${current} -> ${version}`);
