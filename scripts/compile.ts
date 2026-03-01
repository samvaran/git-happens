/**
 * Compile git-happens to a single executable.
 * Usage:
 *   deno task compile              → current platform, output: git-happens[.exe]
 *   deno task compile:all          → all targets into dist/ with versioned filenames
 *
 * Before compiling, syncs version from deno.json to src/version.ts so the binary reports the right version.
 */

const PERMISSIONS = ["--allow-read", "--allow-net", "--allow-run"];

const TARGETS: { target: string; name: string }[] = [
  { target: "x86_64-pc-windows-msvc", name: "git-happens-x64-windows.exe" },
  { target: "x86_64-apple-darwin", name: "git-happens-x64-macos" },
  { target: "aarch64-apple-darwin", name: "git-happens-arm64-macos" },
  { target: "x86_64-unknown-linux-gnu", name: "git-happens-x64-linux" },
  { target: "aarch64-unknown-linux-gnu", name: "git-happens-arm64-linux" },
];

const root = new URL("..", import.meta.url).pathname;

async function syncVersion(): Promise<string> {
  const denoJsonPath = `${root}deno.json`;
  const j = JSON.parse(await Deno.readTextFile(denoJsonPath)) as { version?: string };
  const version = j.version ?? "0.0.0";
  const versionTs = `/** Synced from deno.json by scripts/compile.ts (or deno task sync-version). Single source of truth: deno.json "version". */
export const VERSION = "${version}";
`;
  await Deno.writeTextFile(`${root}src/version.ts`, versionTs);
  return version;
}

const entry = "src/main.ts";
const defaultOut = Deno.build.os === "windows" ? "git-happens.exe" : "git-happens";

async function compileOne(target?: string, out?: string): Promise<boolean> {
  const args = [
    "compile",
    ...PERMISSIONS,
    "-o",
    out ?? defaultOut,
    ...(target ? ["--target", target] : []),
    entry,
  ];
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.spawn().status;
  return status.success;
}

const all = Deno.args.includes("--all");

if (all) {
  const version = await syncVersion();
  console.log(`Version ${version} (synced from deno.json)`);
  await Deno.mkdir("dist", { recursive: true });
  const base = `git-happens-${version}`;
  const versionedNames: Record<string, string> = {
    "x86_64-pc-windows-msvc": `${base}-x64-windows.exe`,
    "x86_64-apple-darwin": `${base}-x64-macos`,
    "aarch64-apple-darwin": `${base}-arm64-macos`,
    "x86_64-unknown-linux-gnu": `${base}-x64-linux`,
    "aarch64-unknown-linux-gnu": `${base}-arm64-linux`,
  };
  for (const { target, name } of TARGETS) {
    const outName = versionedNames[target] ?? name;
    console.log(`\n--- ${target} → ${outName} ---`);
    const ok = await compileOne(target, `dist/${outName}`);
    if (!ok) console.error(`Failed: ${target}`);
  }
  console.log("\nDone. Binaries in dist/");
} else {
  await syncVersion();
  const ok = await compileOne();
  Deno.exit(ok ? 0 : 1);
}
