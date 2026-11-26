import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { releaseCacheKey, releaseDownload } from "./ci-release-download";
import { runBunInstall } from "./ci-install";
import { lockedReleasePackages, rebindReleaseLocations } from "./ci-stage-release-packages";

type InputArchive = { manifest: Record<string, unknown>; integrity: string; archive: string };
type ResolverInput = InputArchive & ({ kind: "release" } | { kind: "git"; resolution: string; archiveId: string });
const releasePattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^/]+\/[^/]+$/;
const bashNpmArchivePattern = /^https:\/\/registry\.npmjs\.org\/bash-web\/-\/bash-web-\d+\.\d+\.\d+\.tgz$/;
const gitPattern = /^(?:git\+https:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?#([\da-f]{7,40})$/;

interface BashWebReleaseRecord {
  url: string;
  sha256: string;
  bytes: number;
  version: string;
  sourceCommit: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package metadata");
  return Object.fromEntries(Object.entries(value));
}

function dependencySpecs(manifest: Record<string, unknown>, root = false): string[] {
  const fields = ["dependencies", "optionalDependencies", "peerDependencies"].concat(root ? ["devDependencies", "overrides"] : []);
  return fields.flatMap(field => manifest[field] ? Object.values(object(manifest[field])).filter((value): value is string => typeof value === "string") : []);
}

async function loadBashWebReleaseRecord(directory: string): Promise<BashWebReleaseRecord | null> {
  let current = resolve(directory);
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(current, "scripts", "bash-web-release-inputs.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Partial<BashWebReleaseRecord>;
      if (
        typeof parsed.url === "string" &&
        typeof parsed.sha256 === "string" &&
        typeof parsed.bytes === "number" &&
        typeof parsed.version === "string" &&
        typeof parsed.sourceCommit === "string"
      ) {
        return parsed as BashWebReleaseRecord;
      }
      throw new Error("Invalid scripts/bash-web-release-inputs.json");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function discoverInputs(
  directory: string,
  manifest: Record<string, unknown>,
  lock: string,
  scratch: string,
  download: typeof releaseDownload,
) {
  const pins = new Map(lockedReleasePackages(lock).map(pin => [pin.url, pin.integrity]));
  const bashRecord = await loadBashWebReleaseRecord(directory);
  const pending = dependencySpecs(manifest, true).concat(Array.from(pins.keys()));
  const seen = new Set<string>();
  const inputs = new Map<string, ResolverInput>();
  for (const spec of pending) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    const metadata = await sourceMetadata(spec, scratch, pins, bashRecord, inputs, download);
    if (metadata) pending.push(...dependencySpecs(metadata));
  }
  return inputs;
}

async function sourceMetadata(
  spec: string,
  scratch: string,
  pins: ReadonlyMap<string, string>,
  bashRecord: BashWebReleaseRecord | null,
  inputs: Map<string, ResolverInput>,
  download: typeof releaseDownload,
): Promise<Record<string, unknown> | undefined> {
  const git = gitPattern.exec(spec);
  const isBashNpm = bashNpmArchivePattern.test(spec);
  if (!git && !releasePattern.test(spec) && !isBashNpm) return undefined;
  const url = git ? `https://codeload.github.com/${git[1]}/${git[2]}/legacy.tar.gz/${git[3]}` : spec;
  const response = await download(url);
  if (!response.ok) throw new Error(`Package source metadata failed: HTTP ${response.status}`);
  const bytes = await response.bytes();
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (pins.has(spec) && pins.get(spec) !== integrity) throw new Error("Locked release integrity mismatch");
  if (isBashNpm && !pins.has(spec)) {
    if (!bashRecord) throw new Error("Missing scripts/bash-web-release-inputs.json for new bash-web npm archive");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (spec !== bashRecord.url || actualSha256 !== bashRecord.sha256 || bytes.byteLength !== bashRecord.bytes) {
      throw new Error("New bash-web npm archive does not match scripts/bash-web-release-inputs.json");
    }
  }
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
  const integrities = new Map<string, string>();
  await mkdir(packageDirectory, { recursive: true });
  for (const input of inputs.values()) {
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify(rebindReleaseLocations(input.manifest, locations)));
    execFileSync("tar", ["-czf", input.archive, "-C", join(scratch, "metadata"), "package"]);
    integrities.set(input.archive, `sha512-${createHash("sha512").update(await readFile(input.archive)).digest("base64")}`);
  }
  return integrities;
}

function stageResolverLock(original: string, locations: ReadonlyMap<string, string>, integrities: ReadonlyMap<string, string>): string {
  const lock = object(rebindReleaseLocations(Bun.JSONC.parse(original), locations));
  const packages = object(lock.packages);
  for (const [name, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("Invalid locked package");
    const spec = entry[0].slice(entry[0].indexOf("@", 1) + 1);
    const integrity = integrities.get(spec);
    if (integrity) packages[name] = [entry[0], entry[1], integrity];
  }
  return JSON.stringify({ ...lock, packages });
}

function intendedGitRevision(before: string, previous: unknown, selected: unknown, inputs: ReadonlyMap<string, ResolverInput>): string | undefined {
  if (typeof previous !== "string" || typeof selected !== "string" || previous === selected) return;
  const oldPin = gitPattern.exec(previous);
  const newPin = gitPattern.exec(selected);
  const locked = gitPattern.exec(before);
  if (!oldPin || !newPin || !locked) return;
  if (locked[1] !== oldPin[1] || locked[2] !== oldPin[2] || !oldPin[3]!.startsWith(locked[3]!)) return;
  const input = inputs.get(selected);
  return input?.kind === "git" ? input.resolution : undefined;
}

function requestedGitRevision(name: string, before: string, after: unknown, root: Record<string, unknown>, manifest: Record<string, unknown>, inputs: ReadonlyMap<string, ResolverInput>): boolean {
  const previous = gitPattern.exec(before);
  if (!previous || !Array.isArray(after) || typeof after[0] !== "string") return false;
  const spec = after[0].slice(after[0].indexOf("@", 1) + 1);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
    const oldPins = object(root[field] ?? {});
    const newPins = object(manifest[field] ?? {});
    if (intendedGitRevision(before, oldPins[name], newPins[name], inputs) === spec) return true;
  }
  return false;
}

function requestedWaffleVersion(name: string, after: unknown, root: Record<string, unknown>, manifest: Record<string, unknown>): boolean {
  if (name !== "@waffle-os/relay" && name !== "@waffle-os/runtime" && name !== "waffle") return false;
  if (!Array.isArray(after)) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const previous = object(root[field] ?? {})[name];
    const pin = object(manifest[field] ?? {})[name];
    if (pin === previous || typeof pin !== "string") continue;
    const prefix = name === "waffle" ? "npm:@waffle-os/runtime@" : "";
    const version = pin.slice(prefix.length);
    if (!pin.startsWith(prefix) || !/^\d+\.\d+\.\d+$/.test(version)) continue;
    const packageName = name === "waffle" ? "@waffle-os/runtime" : name;
    if (after[0] === `${packageName}@${version}`) return true;
  }
  return false;
}

function requestedDirectArchiveChange(name: string, after: unknown, root: Record<string, unknown>, manifest: Record<string, unknown>, locations: ReadonlyMap<string, string>): boolean {
  if (!Array.isArray(after) || typeof after[0] !== "string") return false;
  const afterSpec = after[0].slice(after[0].indexOf("@", 1) + 1);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
    const previous = object(root[field] ?? {})[name];
    const pin = object(manifest[field] ?? {})[name];
    if (typeof pin !== "string" || pin === previous) continue;
    if (locations.has(pin) && !gitPattern.test(pin) && afterSpec === pin) return true;
  }
  return false;
}

function recordRootPin(result: Map<string, Map<string, string>>, name: string, field: string, value: string): void {
  const fields = result.get(name) ?? new Map<string, string>();
  fields.set(field, value);
  result.set(name, fields);
}

function collectRootPins(obj: Record<string, unknown>): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
    const section = obj[field];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [k, v] of Object.entries(section)) {
      if (typeof v === "string") recordRootPin(result, k, field, v);
    }
  }
  return result;
}

function entryDeps(entry: unknown): { deps: string[]; peers: string[] } {
  if (!Array.isArray(entry)) return { deps: [], peers: [] };
  const meta = entry.find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
  if (!meta) return { deps: [], peers: [] };
  const deps: string[] = [];
  for (const field of ["dependencies", "optionalDependencies"]) {
    const section = meta[field];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      deps.push(...Object.keys(section));
    }
  }
  const peers: string[] = [];
  const peerSection = meta.peerDependencies;
  if (peerSection && typeof peerSection === "object" && !Array.isArray(peerSection)) {
    peers.push(...Object.keys(peerSection));
  }
  return { deps, peers };
}

/** Bun ancestor-slot resolution: checks parentSlot/pkgName, walking up ancestor segments, then root pkgName. */
function resolveEdge(packages: Record<string, unknown>, parentSlot: string | null, pkgName: string): string | undefined {
  if (parentSlot) {
    const parts = parentSlot.split("/");
    // Scoped package names occupy 2 segments (@scope/name), unscoped occupy 1 segment.
    const prefixes: string[] = [];
    for (let i = 0; i < parts.length; ) {
      const step = parts[i]!.startsWith("@") ? 2 : 1;
      i += step;
      prefixes.push(parts.slice(0, i).join("/"));
    }
    for (let idx = prefixes.length - 1; idx >= 0; idx--) {
      const candidate = `${prefixes[idx]}/${pkgName}`;
      if (candidate in packages) return candidate;
    }
  }
  return pkgName in packages ? pkgName : undefined;
}

function isAuthorizedRootTransition(
  name: string,
  beforeEntry: unknown,
  afterEntry: unknown,
  root: Record<string, unknown>,
  manifest: Record<string, unknown>,
  locations: ReadonlyMap<string, string>,
  inputs: ReadonlyMap<string, ResolverInput>,
): boolean {
  if (requestedWaffleVersion(name, afterEntry, root, manifest)) return true;
  if (requestedDirectArchiveChange(name, afterEntry, root, manifest, locations)) return true;
  if (Array.isArray(beforeEntry) && typeof beforeEntry[0] === "string") {
    const beforeSpec = beforeEntry[0].slice(beforeEntry[0].indexOf("@", 1) + 1);
    if (requestedGitRevision(name, beforeSpec, afterEntry, root, manifest, inputs)) return true;
  }
  if (beforeEntry === undefined && Array.isArray(afterEntry) && typeof afterEntry[0] === "string") {
    const afterSpec = afterEntry[0].slice(afterEntry[0].indexOf("@", 1) + 1);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"]) {
      const pin = object(manifest[field] ?? {})[name];
      const input = typeof pin === "string" ? inputs.get(pin) : undefined;
      if (input?.kind === "git" && input.resolution === afterSpec) return true;
    }
  }
  return false;
}

function collectReachableSlots(packages: Record<string, unknown>, startSlots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...startSlots];
  while (queue.length > 0) {
    const slot = queue.pop()!;
    if (visited.has(slot) || !(slot in packages)) continue;
    visited.add(slot);
    const { deps, peers } = entryDeps(packages[slot]);
    for (const dep of deps.concat(peers)) {
      const resolved = resolveEdge(packages, slot, dep);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

export function verifyUnrelatedPackages(
  original: string,
  updated: string,
  locations: ReadonlyMap<string, string>,
  inputs: ReadonlyMap<string, ResolverInput>,
  manifest: Record<string, unknown>,
): void {
  const lock = object(Bun.JSONC.parse(original));
  const root = object(object(lock.workspaces)[""]);
  const before = object(lock.packages);
  const after = object(object(Bun.JSONC.parse(updated)).packages);

  const beforeRootPins = collectRootPins(root);
  const afterRootPins = collectRootPins(manifest);

  const changedRootNames = new Set<string>();
  const unchangedRootNames = new Set<string>();
  for (const name of new Set([...beforeRootPins.keys(), ...afterRootPins.keys()])) {
    if (isDeepStrictEqual(beforeRootPins.get(name), afterRootPins.get(name))) {
      unchangedRootNames.add(name);
    } else {
      changedRootNames.add(name);
    }
  }

  // Validate every requested changed root slot itself.
  for (const name of changedRootNames) {
    if (!(name in after)) continue;
    const beforeEntry = before[name];
    const afterEntry = after[name];
    if (isDeepStrictEqual(beforeEntry, afterEntry)) continue;
    if (!isAuthorizedRootTransition(name, beforeEntry, afterEntry, root, manifest, locations, inputs)) {
      throw new Error(`Lock update changed an unauthorized root package: ${name}`);
    }
  }

  // Walk every dependency edge reachable from unchanged root pins in both before and after.
  const authorizedSlots = new Set<string>();
  const visitedPairs = new Set<string>();
  const walkUnchangedSubtree = (beforeSlot: string, afterSlot: string) => {
    const pairKey = `${beforeSlot}\0${afterSlot}`;
    if (visitedPairs.has(pairKey)) return;
    visitedPairs.add(pairKey);

    const beforeEntry = before[beforeSlot];
    const afterEntry = after[afterSlot];
    if (!isDeepStrictEqual(beforeEntry, afterEntry)) {
      throw new Error(`Lock update changed an unrelated package: ${beforeSlot}`);
    }
    authorizedSlots.add(afterSlot);

    const { deps, peers } = entryDeps(beforeEntry);
    for (const dep of deps) {
      const bChild = resolveEdge(before, beforeSlot, dep);
      const aChild = resolveEdge(after, afterSlot, dep);
      if (!bChild && !aChild) continue;
      if (!bChild || !aChild) {
        throw new Error(`Lock update changed an unrelated dependency edge: ${beforeSlot} -> ${dep}`);
      }
      walkUnchangedSubtree(bChild, aChild);
    }
    for (const peer of peers) {
      const bPeer = resolveEdge(before, beforeSlot, peer);
      const aPeer = resolveEdge(after, afterSlot, peer);
      if (!bPeer && !aPeer) continue;
      if (!bPeer || !aPeer) {
        throw new Error(`Lock update changed an unrelated peer edge: ${beforeSlot} -> ${peer}`);
      }
      const bTarget = before[bPeer];
      const aTarget = after[aPeer];
      if (isDeepStrictEqual(bTarget, aTarget)) {
        authorizedSlots.add(aPeer);
        continue;
      }
      // Peer rebinding is authorized ONLY when both before and after resolve to the exact root slot
      // and that root slot is a verified requested root transition!
      const exactRootProvider =
        bPeer === peer &&
        aPeer === peer &&
        changedRootNames.has(peer) &&
        isAuthorizedRootTransition(peer, before[peer], after[peer], root, manifest, locations, inputs) &&
        isDeepStrictEqual(aTarget, after[peer]);
      if (!exactRootProvider) {
        throw new Error(`Lock update changed an unrelated peer provider: ${beforeSlot} -> ${peer} (${aPeer})`);
      }
      authorizedSlots.add(aPeer);
    }
  };

  for (const name of unchangedRootNames) {
    const bSlot = resolveEdge(before, null, name);
    const aSlot = resolveEdge(after, null, name);
    if (!bSlot && !aSlot) continue;
    if (!bSlot || !aSlot) {
      throw new Error(`Lock update changed an unrelated package: ${name}`);
    }
    walkUnchangedSubtree(bSlot, aSlot);
  }

  // Every slot reachable from authorized changed root slots is justified.
  const changedReachable = collectReachableSlots(after, Array.from(changedRootNames));
  for (const slot of changedReachable) {
    authorizedSlots.add(slot);
  }

  // Every non-identical or newly introduced slot in after.packages MUST be justified.
  for (const [slot, afterEntry] of Object.entries(after)) {
    if (authorizedSlots.has(slot)) continue;
    if (slot in before && isDeepStrictEqual(before[slot], afterEntry)) continue;
    throw new Error(`Lock update introduced or changed an unrelated package: ${slot}`);
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
    const inputs = await discoverInputs(
      directory,
      metadata,
      lock.toString(),
      scratch,
      (url, options) => download(url, { ...options, signal: AbortSignal.any([controller.signal, options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 180_000)]) }),
    );
    const locations = resolverLocations(inputs);
    const integrities = await writeResolverInputs(inputs, scratch, locations);
    await writeFile(join(directory, "package.json"), JSON.stringify(rebindReleaseLocations(metadata, locations)));
    await writeFile(join(directory, "bun.lock"), stageResolverLock(lock.toString(), locations, integrities));
    await runBunInstall(directory, ["--lockfile-only", "--ignore-scripts"].concat(offline ? ["--offline"] : []), controller.signal);
    const updated = canonicalLock(await readFile(join(directory, "bun.lock"), "utf8"), locations, inputs);
    verifyUnrelatedPackages(lock.toString(), updated, locations, inputs, metadata);
    result = updated;
  } finally {
    await writeFile(join(directory, "package.json"), manifest);
    await writeFile(join(directory, "bun.lock"), result);
    await rm(scratch, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}

if (import.meta.main) await updateReleaseLock(resolve(process.argv[2] ?? "."));
