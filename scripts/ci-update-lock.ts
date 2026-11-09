import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseCacheKey, releaseDownload } from "./ci-release-download";
import { runBunInstall } from "./ci-install";
import { lockedReleasePackages, rebindReleaseLocations } from "./ci-stage-release-packages";

type InputArchive = { manifest: Record<string, unknown>; integrity: string; archive: string };
type ResolverInput = InputArchive & ({ kind: "release" } | { kind: "git"; resolution: string; archiveId: string });
const releasePattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^/]+\/[^/]+$/;
const gitPattern = /^(?:git\+https:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?#([\da-f]{7,40})$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package metadata");
  return Object.fromEntries(Object.entries(value));
}

function dependencySpecs(manifest: Record<string, unknown>, root = false): string[] {
  const fields = ["dependencies", "optionalDependencies", "peerDependencies"].concat(root ? ["devDependencies", "overrides"] : []);
  return fields.flatMap(field => manifest[field] ? Object.values(object(manifest[field])).filter((value): value is string => typeof value === "string") : []);
}

async function discoverInputs(manifest: Record<string, unknown>, lock: string, scratch: string, download: typeof releaseDownload) {
  const pins = new Map(lockedReleasePackages(lock).map(pin => [pin.url, pin.integrity]));
  const pending = dependencySpecs(manifest, true).concat(Array.from(pins.keys()));
  const seen = new Set<string>();
  const inputs = new Map<string, ResolverInput>();
  for (const spec of pending) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    const metadata = await sourceMetadata(spec, scratch, pins, inputs, download);
    if (metadata) pending.push(...dependencySpecs(metadata));
  }
  return inputs;
}

async function sourceMetadata(spec: string, scratch: string, pins: ReadonlyMap<string, string>, inputs: Map<string, ResolverInput>, download: typeof releaseDownload): Promise<Record<string, unknown> | undefined> {
  const git = gitPattern.exec(spec);
  if (!git && !releasePattern.test(spec)) return undefined;
  const url = git ? `https://codeload.github.com/${git[1]}/${git[2]}/legacy.tar.gz/${git[3]}` : spec;
  const response = await download(url);
  if (!response.ok) throw new Error(`Package source metadata failed: HTTP ${response.status}`);
  const bytes = await response.bytes();
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (pins.has(spec) && pins.get(spec) !== integrity) throw new Error("Locked release integrity mismatch");
  const archive = join(scratch, `${releaseCacheKey(spec)}.tgz`);
  await writeFile(archive, bytes);
  const prefix = git ? execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n")[0]!.replace(/\/$/, "") : "package";
  const manifest = object(JSON.parse(execFileSync("tar", ["-xOzf", archive, "--", `${prefix}/package.json`], { encoding: "utf8" })));
  const input = { manifest, integrity, archive: join(scratch, `${releaseCacheKey(spec)}-metadata.tgz`) };
  if (!git) { inputs.set(spec, { kind: "release", ...input }); return manifest; }
  const expected = `${git[1]}-${git[2]}-`;
  const revision = prefix.slice(expected.length);
  if (!prefix.startsWith(expected) || !/^[a-f0-9]{7,40}$/.test(revision) || !git[3]!.startsWith(revision)) throw new Error("Invalid Git archive identity");
  inputs.set(spec, { kind: "git", ...input, resolution: `github:${git[1]}/${git[2]}#${revision}`, archiveId: prefix });
  return manifest;
}

function resolverLocations(inputs: ReadonlyMap<string, ResolverInput>): Map<string, string> {
  const locations = new Map<string, string>();
  for (const [spec, input] of inputs) {
    if (input.kind === "git") locations.set(input.resolution, input.archive);
    locations.set(spec, input.archive);
  }
  return locations;
}

async function writeResolverInputs(inputs: ReadonlyMap<string, ResolverInput>, scratch: string, locations: ReadonlyMap<string, string>) {
  const packageDirectory = join(scratch, "metadata", "package");
  await mkdir(packageDirectory, { recursive: true });
  for (const input of inputs.values()) {
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify(rebindReleaseLocations(input.manifest, locations)));
    execFileSync("tar", ["-czf", input.archive, "-C", join(scratch, "metadata"), "package"]);
  }
}

function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${inlineJson(entry)}`).join(", ")} }`;
}

function canonicalLock(staged: string, locations: ReadonlyMap<string, string>, inputs: ReadonlyMap<string, ResolverInput>): string {
  const reverse = new Map(Array.from(locations, ([url, local]) => [local, url]));
  const restored = staged.replace(/"(?:[^"\\]|\\.)*"/g, token => JSON.stringify(rebindReleaseLocations(JSON.parse(token), reverse)));
  const lock = object(Bun.JSONC.parse(restored));
  const packages = object(lock.packages);
  for (const [name, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("Invalid resolved lock entry");
    const spec = entry[0].slice(entry[0].indexOf("@", 1) + 1);
    const input = inputs.get(spec);
    if (input?.kind === "git") {
      const packageName = entry[0].slice(0, entry[0].indexOf("@", 1));
      packages[name] = [`${packageName}@${input.resolution}`, entry[1], input.archiveId, input.integrity];
    } else if (input) entry[entry.length - 1] = input.integrity;
  }
  return restored.split("\n").map(line => {
    const match = /^    ("(?:[^"\\]|\\.)*"): \[/.exec(line);
    if (!match) return line;
    const entry = packages[JSON.parse(match[1]!)];
    return `    ${match[1]}: ${inlineJson(entry)},`;
  }).join("\n");
}

export async function updateReleaseLock(directory: string, download = releaseDownload, offline = false): Promise<void> {
  const manifest = await readFile(join(directory, "package.json"));
  const lock = await readFile(join(directory, "bun.lock"));
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-update-lock-"));
  let result = lock.toString();
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  try {
    const metadata = object(JSON.parse(manifest.toString()));
    const inputs = await discoverInputs(metadata, lock.toString(), scratch, (url, options) => download(url, { ...options, signal: AbortSignal.any([controller.signal, options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 180_000)]) }));
    const locations = resolverLocations(inputs);
    await writeResolverInputs(inputs, scratch, locations);
    await writeFile(join(directory, "package.json"), JSON.stringify(rebindReleaseLocations(metadata, locations)));
    await writeFile(join(directory, "bun.lock"), JSON.stringify(rebindReleaseLocations(Bun.JSONC.parse(lock.toString()), locations)));
    await runBunInstall(directory, ["--lockfile-only", "--ignore-scripts"].concat(offline ? ["--offline"] : []), controller.signal);
    result = canonicalLock(await readFile(join(directory, "bun.lock"), "utf8"), locations, inputs);
  } finally {
    await writeFile(join(directory, "package.json"), manifest);
    await writeFile(join(directory, "bun.lock"), result);
    await rm(scratch, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}

if (import.meta.main) await updateReleaseLock(resolve(process.argv[2] ?? "."));
