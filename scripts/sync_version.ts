/**
 * Sync version from deno.json to src/version.ts.
 * Run when bumping: deno task sync-version
 */
const root = new URL("..", import.meta.url).pathname;
const j = JSON.parse(await Deno.readTextFile(`${root}deno.json`)) as { version?: string };
const version = j.version ?? "0.0.0";
await Deno.writeTextFile(
  `${root}src/version.ts`,
  `/** Synced from deno.json by scripts/compile.ts (or deno task sync-version). Single source of truth: deno.json "version". */
export const VERSION = "${version}";
`,
);
console.log(`Synced version ${version} to src/version.ts`);
