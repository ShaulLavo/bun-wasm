import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { buildBrowserEntries } from "./browser-build";
import { hash, guestBuilds } from "./guest-source-manifest";
import { importedMemory } from "../src/engine-kind";
import { validateSelection, type BrowserGuestSelection } from "./browser-guest-catalogue";

const repository = resolve(import.meta.dir, "..");
const coreBuilds = ["browser", "quickjs", "jsc", "tools"] as const;
type CoverageBuild = typeof coreBuilds[number];
export interface VerifiedBrowserGuestCoverage {
  readonly site: string;
  readonly selection: BrowserGuestSelection;
  readonly interruptionBundle: string | undefined;
  readonly programs: ReadonlyMap<string, Uint8Array>;
}

function requiredFile(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing required browser coverage file: ${path}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing served engine identity maps");
  return Object.fromEntries(Object.entries(value));
}

function requiredBuilds(selection: BrowserGuestSelection): CoverageBuild[] {
  validateSelection(selection);
  if (!selection.length) throw new Error("Coverage artifact requires selected rows");
  const tools = selection.some(item => item.owner === "tools-integrity");
  return coreBuilds.filter(build => build === "browser" || build === "tools" && tools || build === "quickjs" && tools
    || selection.some(item => item.engines.some(engine => engine === build)));
}
function requiredPrograms(selection: BrowserGuestSelection): string[] {
  return requiredBuilds(selection).flatMap(build => {
    const core = guestBuilds[build].artifact;
    return build === "quickjs" ? [core, "quickjs.wasm"] : build === "jsc" ? [core, "jsc-engine.wasm"] : [core];
  });
}
function selectedInterruption(selection: BrowserGuestSelection): boolean {
  return selection.some(item => item.owner === "engine-interruption");
}
const bundleEntries = ["engine-interruption-page.js", "engine-interruption-worker.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js", "index.html"];
function requireBundle(out: string): void {
  for (const name of bundleEntries) {
    if (!lstatSync(join(out, "interruption", name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing interruption bundle entry: ${name}`);
  }
}

/** Producer only, after its ordinary site build. Refuses a second build in the same artifact. */
export async function prepareBrowserGuestInterruptionBundle(request: { out: string; selection: BrowserGuestSelection }): Promise<string | undefined> {
  validateSelection(request.selection);
  if (!selectedInterruption(request.selection)) return;
  const out = join(request.out, "interruption");
  mkdirSync(out); // Exclusive creation also prevents accidental repeated builds.
  await buildBrowserEntries(["web/tests/engine-interruption-page.ts", "web/tests/engine-interruption-worker.ts", "web/src/worker.ts", "web/src/fs-worker.ts", "web/src/notification-worker.ts"].map(path => join(repository, path)), out, { runtimeWorker: true });
  writeFileSync(join(out, "index.html"), '<!doctype html><script type="module" src="./engine-interruption-page.js"></script>');
  requireBundle(request.out);
  return out;
}

function engineMaps(site: string) {
  const manifest = object(JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8")));
  const embeddedJson = /globalThis\.__bunwasmBuilds\s*=\s*(\{[^;]*?\})\s*;?/.exec(readFileSync(join(site, "index.html"), "utf8"))?.[1];
  const embedded = object(embeddedJson ? JSON.parse(embeddedJson) : undefined);
  return { manifest, embedded };
}
function verifyRepresentations(site: string, path: string, expected: string, suffixes = ["", ".br"]): void {
  for (const suffix of suffixes) {
    const file = join(site, path + suffix);
    if (!lstatSync(file, { throwIfNoEntry: false })) continue;
    const bytes = readFileSync(file);
    const decoded = suffix === ".br" ? brotliDecompressSync(bytes) : suffix === ".gz" ? gunzipSync(bytes) : bytes;
    if (hash(decoded) !== expected) throw new Error(`Served representation differs: ${path}${suffix}`);
  }
}
function decodePrograms(site: string, selection: BrowserGuestSelection): Map<string, Uint8Array> {
  const maps = engineMaps(site);
  return new Map(requiredPrograms(selection).map(name => {
    requiredFile(join(site, name + ".gz"));
    const bytes = gunzipSync(readFileSync(join(site, name + ".gz"))), identity = hash(bytes);
    if (identity !== maps.manifest[name] || identity !== maps.embedded[name]) throw new Error(`Served program identity mismatch: ${name}`);
    if (!WebAssembly.validate(bytes) || importedMemory(bytes)?.shared) throw new Error(`Invalid split coverage program: ${name}`);
    verifyRepresentations(site, name, identity);
    return [name, bytes];
  }));
}
function programBytes(programs: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const bytes = programs.get(name);
  if (!bytes) throw new Error(`Missing selected program: ${name}`);
  return bytes;
}
async function requireShellAndBase(site: string): Promise<void> {
  for (const name of ["shell-engine.wasm", "env.wasm"]) requiredFile(join(site, "programs", name));
  const entry = Bun.resolveSync("waffle-base", join(repository, "web"));
  const { basePrograms }: typeof import("waffle-base") = await import(entry);
  const wasmPrograms = basePrograms.filter(program => program.wasm);
  if (!wasmPrograms.length) throw new Error("Pinned base installation has no WASM assets");
  for (const program of wasmPrograms) {
    if (!program.wasm) continue;
    const path = fileURLToPath(program.wasm), family = basename(resolve(dirname(path), ".."));
    requiredFile(join(site, "programs/base", family, "dist", basename(path)));
  }
}

/** Check the selected runtime inputs directly. CI reuses its same-run site; local builds work too. */
export async function verifyBrowserGuestCoverage(request: { out: string; selection: BrowserGuestSelection }): Promise<VerifiedBrowserGuestCoverage> {
  requiredBuilds(request.selection);
  const site = join(request.out, "site");
  for (const name of ["index.html", "main.js", "sw.js", "worker.js", "fs-worker.js", "notification-worker.js", "preview1-worker.js"]) requiredFile(join(site, name));
  await requireShellAndBase(site);
  if (selectedInterruption(request.selection)) requireBundle(request.out);
  const programs = decodePrograms(site, request.selection);
  const browser = programBytes(programs, "bun-browser.wasm");
  requiredFile(join(site, "sandbox/bun-browser.wasm.gz"));
  const sandbox = gunzipSync(readFileSync(join(site, "sandbox/bun-browser.wasm.gz")));
  const sandboxMaps = object(JSON.parse(readFileSync(join(site, "sandbox/engine-builds.json"), "utf8")));
  if (hash(sandbox) !== hash(browser) || sandboxMaps["bun-browser.wasm"] !== hash(browser)) throw new Error("Sandbox guest differs from served Browser program");
  return { site, selection: request.selection, programs,
    interruptionBundle: selectedInterruption(request.selection) ? join(request.out, "interruption") : undefined };
}

/** Caller removes private raw staging after its supervised child drains. */
export function stageBrowserGuestInterruption(verified: VerifiedBrowserGuestCoverage, directory: string): void {
  if (!verified.interruptionBundle) throw new Error("Interruption was not selected");
  mkdirSync(directory);
  const selection = verified.selection.filter(item => item.owner === "engine-interruption");
  for (const name of requiredPrograms(selection)) writeFileSync(join(directory, name), programBytes(verified.programs, name), { flag: "wx", mode: 0o400 });
}

if (import.meta.main) {
  const [out, serialized] = process.argv.slice(2);
  if (!out || !serialized) throw new Error("Usage: browser-guest-coverage.ts <out> <selection-json>");
  const { parseBrowserGuestSelection } = await import("./browser-guest-catalogue");
  await prepareBrowserGuestInterruptionBundle({ out: resolve(out), selection: parseBrowserGuestSelection(JSON.parse(serialized)) });
}
