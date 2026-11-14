import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Archive = { uri: string; filename: string; size: number; sha256: string };
const ubuntuSources = "/etc/apt/sources.list.d/ubuntu.sources";

export function missingPackages(output: string): string[] {
  if (output.trim() === "All system dependencies are installed.") return [];
  const match = /^Missing system dependencies \((\d+)\):\n([\s\S]+)$/.exec(output.trim());
  if (!match) throw new Error(`Unexpected Playwright dependency report: ${output}`);
  const packages = (match[2] ?? "").trim().split(/\s+/);
  if (packages.length !== Number(match[1]) || packages.some(name => !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(name))) {
    throw new Error("Invalid Playwright package list");
  }
  return packages;
}

export function parseArchives(output: string): Archive[] {
  return output.split("\n").filter(line => line.startsWith("'")).map(line => {
    const match = /^'([^']+)' ([A-Za-z0-9%+_.~-]+\.deb) ([0-9]+) SHA256:([a-f0-9]{64})$/.exec(line);
    if (!match) throw new Error(`Expected a SHA256-verified apt archive: ${line}`);
    const [, uri = "", filename = "", size = "", sha256 = ""] = match;
    if (!/^(?:https:|mirror\+file:)/.test(uri)) throw new Error(`Unexpected apt transport: ${uri}`);
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Invalid archive size: ${size}`);
    return { uri, filename, size: bytes, sha256 };
  });
}

export async function inBatches<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Expected positive concurrency");
  for (let index = 0; index < items.length; index += concurrency) {
    const results = await Promise.allSettled(items.slice(index, index + concurrency).map(task));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

function apt(args: string[], capture = false): string {
  const result = spawnSync("sudo", ["apt-get"].concat(args, [
    "-o", `Dir::Etc::sourcelist=${ubuntuSources}`, "-o", "Dir::Etc::sourceparts=-",
  ]), {
    encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`apt-get ${args[0]} failed: ${result.status}`);
  return result.stdout ?? "";
}

async function downloadArchive(archive: Archive, directory: string): Promise<void> {
  const target = join(directory, archive.filename);
  console.log(`APT archive ${archive.uri} ${archive.size} SHA256:${archive.sha256}`);
  const child = Bun.spawn(["/usr/lib/apt/apt-helper", "download-file", archive.uri, target, `SHA256:${archive.sha256}`], {
    stdout: "inherit", stderr: "inherit", env: { ...process.env, LC_ALL: "C" },
  });
  if (await child.exited !== 0) throw new Error(`APT archive download failed: ${archive.filename}`);
}

async function archiveMatches(archive: Archive, target: string): Promise<boolean> {
  if (!await Bun.file(target).exists()) return false;
  const bytes = await readFile(target);
  if (bytes.length !== archive.size) return false;
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === archive.sha256;
}

export async function prefetchArchive(archive: Archive, directory: string, download = downloadArchive): Promise<void> {
  const target = join(directory, archive.filename);
  if (await archiveMatches(archive, target)) {
    console.log(`Reuse verified APT archive ${archive.filename}`);
    return;
  }
  await rm(target, { force: true });
  await download(archive, directory);
  if (!await archiveMatches(archive, target)) throw new Error(`APT archive verification failed: ${archive.filename}`);
}

export async function planArchives(install: string[], temporary: string, run = apt): Promise<Archive[]> {
  const directory = await mkdtemp(join(temporary, "browser-apt-plan-"));
  try {
    const plan = run(["--print-uris", "--download-only"].concat(install, ["-o", `Dir::Cache::archives=${directory}`]), true);
    return parseArchives(plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function pruneArchives(archives: readonly Archive[], directory: string): Promise<void> {
  const planned = new Set(archives.map(archive => archive.filename));
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(".deb") || planned.has(filename)) continue;
    await rm(join(directory, filename), { force: true });
  }
}

function dependencyPackages(browsers: string[]): string[] {
  const cli = fileURLToPath(new URL("../node_modules/playwright/cli.js", import.meta.url));
  const report = spawnSync(process.execPath, [cli, "install-deps", "--dry-run"].concat(browsers), { encoding: "utf8" });
  if (report.error) throw report.error;
  if (report.status !== 0 && report.status !== 1) throw new Error(report.stderr || "Playwright dependency inspection failed");
  console.log(report.stdout);
  return missingPackages(report.stdout);
}

async function main(): Promise<void> {
  const browsers = process.argv.slice(2);
  if (!browsers.length || browsers.some(browser => !["chromium", "firefox", "webkit"].includes(browser))) {
    throw new Error("Usage: ci-browser-deps.ts <chromium|firefox|webkit>...");
  }
  const temporary = process.env.RUNNER_TEMP;
  if (process.env.GITHUB_ACTIONS !== "true" || !temporary) throw new Error("System setup is restricted to GitHub Actions");
  if (!(await readFile(ubuntuSources, "utf8")).trim()) throw new Error(`Empty Ubuntu apt sources: ${ubuntuSources}`);
  const directory = join(temporary, "browser-apt");
  await mkdir(directory, { recursive: true });
  let complete = false;
  try {
    complete = dependencyPackages(["chromium", "firefox", "webkit"]).length === 0;
  } catch {
    console.log("Dependency inspection needs fresh signed Ubuntu indexes");
  }
  if (complete) {
    await pruneArchives([], directory);
    return;
  }
  apt(["update", "--error-on=any"]);
  const packages = dependencyPackages(browsers);
  const pool = dependencyPackages(["chromium", "firefox", "webkit"]);
  const install = ["install", "--yes", "--no-install-recommends", "-o", `Dir::Cache::archives=${directory}`, "-o", "Acquire::ForceHash=SHA256", "-o", "APT::Keep-Downloaded-Packages=true"];
  const archives = await planArchives(install.concat(pool), temporary);
  console.log(`Prefetch ${archives.length} signed-index apt archives with concurrency 16`);
  await inBatches(archives, 16, archive => prefetchArchive(archive, directory));
  await pruneArchives(archives, directory);
  if (packages.length) apt(install.concat(packages));
}

if (import.meta.main) await main();
