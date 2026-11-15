import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { verifiedGuests, pinnedBashWeb } from "./bash-web-guests";
import { buildBrowserEntries } from "./browser-build";
import { verifySite, type SiteIdentity } from "./browser-guest-site";
import { verifyGuestBuildReceipt, artifactIdentity, type GuestBuildReceipt } from "./guest-build-receipt";
import { record, verifyProgramReceipt } from "./guest-core-receipt";
import { hash, guestBuilds } from "./guest-source-manifest";
import { importedMemory } from "../src/engine-kind";
import { validateSelection, parseBrowserGuestSelection, type BrowserGuestSelection } from "./browser-guest-catalogue";

const repository = resolve(import.meta.dir, "..");
const coreBuilds = ["browser", "quickjs", "jsc", "tools"] as const;
type CoverageBuild = typeof coreBuilds[number];
type Inventory = Record<string, string>;
interface CoverageIdentity {
  readonly schema: 1;
  readonly profile: "split";
  readonly source: SiteIdentity["source"];
  readonly selection: BrowserGuestSelection;
  readonly siteSha256: string;
  readonly files: Inventory;
  readonly shell: { readonly pin: string; readonly files: Inventory };
}
export interface VerifiedBrowserGuestCoverage {
  readonly site: string;
  readonly selection: BrowserGuestSelection;
  readonly interruptionBundle: string | undefined;
  /** Copies from this verification, reused for private interruption staging. */
  readonly programs: ReadonlyMap<string, Uint8Array>;
  /** Hash comparison only. Does not decode or compile the Wasm again. */
  readonly assertUnchanged: () => void;
}

function source() {
  const [head, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim().split("\n");
  if (!head || !tree) throw new Error("Missing checkout source");
  return { head, tree };
}
function inventory(directory: string, prefix = ""): Inventory {
  const files: Inventory = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), key = prefix + name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) Object.assign(files, inventory(path, key + "/"));
    else if (stat.isFile()) files[key] = hash(readFileSync(path));
    else throw new Error(`Non-regular coverage file: ${path}`);
  }
  return files;
}
function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
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

function supplementalInventory(out: string, interruption: boolean): Inventory {
  const files = inventory(join(out, "coverage-receipts"), "coverage-receipts/");
  if (interruption) Object.assign(files, inventory(join(out, "interruption"), "interruption/"));
  else if (lstatSync(join(out, "interruption"), { throwIfNoEntry: false })) throw new Error("Unselected interruption bundle");
  return files;
}
function engineMaps(site: string): { manifest: Record<string, unknown>; embedded: Record<string, unknown> } {
  const manifest: unknown = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
  const embeddedJson = /globalThis\.__bunwasmBuilds\s*=\s*(\{[^;]*?\})\s*;/.exec(readFileSync(join(site, "index.html"), "utf8"))?.[1];
  const embedded: unknown = embeddedJson ? JSON.parse(embeddedJson) : undefined;
  if (!record(manifest) || !record(embedded)) throw new Error("Missing served engine identity maps");
  return { manifest, embedded };
}
function decodePrograms(out: string, selection: BrowserGuestSelection): Map<string, Uint8Array> {
  const site = join(out, "site"), maps = engineMaps(site);
  return new Map(requiredPrograms(selection).map(name => {
    const bytes = gunzipSync(readFileSync(join(site, name + ".gz")));
    if (hash(bytes) !== maps.manifest[name] || hash(bytes) !== maps.embedded[name]) throw new Error(`Served program identity mismatch: ${name}`);
    verifyRepresentations(site, name, hash(bytes), ["", ".br"]);
    return [name, bytes];
  }));
}
function programBytes(programs: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const bytes = programs.get(name);
  if (!bytes) throw new Error(`Missing selected program: ${name}`);
  return bytes;
}
async function verifySelectedReceipts(out: string, selection: BrowserGuestSelection, site: SiteIdentity, programs: ReadonlyMap<string, Uint8Array>): Promise<void> {
  let common: Pick<GuestBuildReceipt, "bunHead" | "bunTree" | "sysrootReceiptSha256"> | undefined;
  for (const build of requiredBuilds(selection)) {
    const name = guestBuilds[build].artifact;
    const receipt: unknown = JSON.parse(readFileSync(join(out, "coverage-receipts", name + ".build.json"), "utf8"));
    const bytes = programBytes(programs, name);
    if (build === "browser") equal(receipt, site.receipt, "Supplemental Browser receipt differs from site");
    // Browser was already fully validated by verifySite; retain its assertion type here.
    const verified = build === "browser" ? site.receipt : validatedReceipt(bytes, receipt);
    if (verified.profile !== undefined || verified.sourceManifest.build !== build) throw new Error(`Not the standard split recipe: ${build}`);
    equal(verified.sourceManifest.source, site.source, "Foreign composing receipt source");
    const provenance = { bunHead: verified.bunHead, bunTree: verified.bunTree, sysrootReceiptSha256: verified.sysrootReceiptSha256 };
    if (common) equal(provenance, common, "Guest producer provenance differs");
    common ??= provenance;
    verifySide(verified, programs);
  }
}
function validatedReceipt(bytes: Uint8Array, value: unknown): GuestBuildReceipt {
  verifyGuestBuildReceipt(bytes, value);
  return value;
}
function verifySide(receipt: GuestBuildReceipt, programs: ReadonlyMap<string, Uint8Array>): void {
  if (receipt.program.kind === "single") return;
  if (!("engineOrigin" in receipt)) throw new Error("Missing paired engine origin");
  const name = receipt.program.kind === "quickjs" ? "quickjs.wasm" : "jsc-engine.wasm";
  const side = programBytes(programs, name);
  if (importedMemory(side)?.shared) throw new Error("Selected side is not split");
  // verifyProgramReceipt compiles once and verifies the engine declaration and original inputs.
  verifyProgramReceipt(side, receipt.engineOrigin, receipt.engineOrigin.inputs);
  equal(artifactIdentity(side), receipt.program.side, "Paired engine bytes differ");
}

async function qualifiedShell(request: { dist: string; consumer: string; site: string }): Promise<CoverageIdentity["shell"]> {
  const pin = pinnedBashWeb(request.consumer);
  const guests = verifiedGuests(request.dist, pin);
  if (!guests) throw new Error("Selected browser coverage requires the verified shell/env set");
  const files: Inventory = {};
  for (const { program, path } of guests) files[`programs/${program}`] = hash(readFileSync(path));
  const entry = Bun.resolveSync("waffle-base", request.consumer);
  const { basePrograms }: typeof import("waffle-base") = await import(entry);
  for (const program of basePrograms) {
    if (!program.wasm) continue;
    const path = fileURLToPath(program.wasm);
    const family = basename(resolve(dirname(path), ".."));
    files[`programs/base/${family}/dist/${basename(path)}`] = hash(readFileSync(path));
  }
  if (!Object.keys(files).some(path => path.startsWith("programs/base/"))) throw new Error("Pinned base installation has no WASM assets");
  verifyShell(request.site, files);
  return { pin, files };
}
function verifyShell(site: string, files: Inventory): void {
  if (!("programs/shell-engine.wasm" in files) || !("programs/env.wasm" in files)) throw new Error("Missing qualified served shell/env identities");
  for (const [path, expected] of Object.entries(files)) {
    if (hash(readFileSync(join(site, path))) !== expected) throw new Error(`Served shell/base bytes differ: ${path}`);
    verifyRepresentations(site, path, expected);
  }
}
function verifyRepresentations(site: string, path: string, expected: string, suffixes = ["", ".br", ".gz"]): void {
  for (const suffix of suffixes) {
    const file = join(site, path + suffix);
    if (!lstatSync(file, { throwIfNoEntry: false })) continue;
    const bytes = readFileSync(file);
    const decoded = suffix === ".br" ? brotliDecompressSync(bytes) : suffix === ".gz" ? gunzipSync(bytes) : bytes;
    if (hash(decoded) !== expected) throw new Error(`Served representation differs: ${path}${suffix}`);
  }
}

/** No site/native build. Call once with the existing producer's site and original receipts. */
export async function prepareBrowserGuestCoverage(request: { out: string; dist: string; selection: BrowserGuestSelection; consumer?: string }): Promise<VerifiedBrowserGuestCoverage> {
  const site = verifySite(request.out);
  const builds = requiredBuilds(request.selection);
  const directory = join(request.out, "coverage-receipts");
  mkdirSync(directory);
  for (const build of builds) {
    const name = guestBuilds[build].artifact + ".build.json";
    writeFileSync(join(directory, name), readFileSync(join(request.dist, name)), { flag: "wx" });
  }
  const interruption = selectedInterruption(request.selection);
  if (interruption) requireBundle(request.out);
  const shell = await qualifiedShell({ dist: request.dist, consumer: request.consumer ?? join(repository, "web"), site: join(request.out, "site") });
  const identity: CoverageIdentity = { schema: 1, profile: "split", source: site.source, selection: request.selection,
    siteSha256: hash(JSON.stringify(site.files)), shell, files: supplementalInventory(request.out, interruption) };
  writeFileSync(join(request.out, "coverage.json"), JSON.stringify(identity), { flag: "wx" });
  return verifyBrowserGuestCoverage({ out: request.out, selection: request.selection });
}

export async function verifyBrowserGuestCoverage(request: { out: string; selection: BrowserGuestSelection }): Promise<VerifiedBrowserGuestCoverage> {
  requiredBuilds(request.selection);
  const metadataPath = join(request.out, "coverage.json");
  const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!record(metadata) || metadata.schema !== 1 || metadata.profile !== "split" || !record(metadata.shell) || typeof metadata.shell.pin !== "string" || !record(metadata.shell.files)) throw new Error("Invalid supplemental coverage contract");
  const produced = parseBrowserGuestSelection(metadata.selection);
  for (const item of request.selection) {
    if (!produced.some(other => other.owner === item.owner && item.engines.every(engine => other.engines.includes(engine)))) throw new Error(`Artifact omitted selected engine/owner: ${item.owner}`);
  }
  const site = verifySite(request.out);
  equal(metadata.source, source(), "Foreign supplemental coverage source");
  equal(metadata.source, site.source, "Supplemental/site source differs");
  equal(metadata.siteSha256, hash(JSON.stringify(site.files)), "Supplemental site inventory differs");
  equal(metadata.files, supplementalInventory(request.out, selectedInterruption(produced)), "Supplemental inventory differs");
  const shellFiles: Inventory = {};
  for (const [path, value] of Object.entries(metadata.shell.files)) {
    if (!/^programs\/(?:shell-engine\.wasm|env\.wasm|base\/[a-z-]+\/dist\/[a-zA-Z0-9_.-]+)$/.test(path) || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid shell/base inventory");
    shellFiles[path] = value;
  }
  if (metadata.shell.pin !== pinnedBashWeb(join(repository, "web"))) throw new Error("Supplemental shell pin differs from checkout");
  verifyShell(join(request.out, "site"), shellFiles);
  const programs = decodePrograms(request.out, request.selection);
  await verifySelectedReceipts(request.out, request.selection, site, programs);
  const immutable = { site: inventory(join(request.out, "site")), supplemental: supplementalInventory(request.out, selectedInterruption(produced)),
    siteIdentity: hash(readFileSync(join(request.out, "site.json"))), metadata: hash(readFileSync(metadataPath)) };
  return { site: join(request.out, "site"), selection: request.selection, programs,
    interruptionBundle: selectedInterruption(request.selection) ? join(request.out, "interruption") : undefined,
    assertUnchanged() {
      equal({ site: inventory(join(request.out, "site")), supplemental: supplementalInventory(request.out, selectedInterruption(produced)),
        siteIdentity: hash(readFileSync(join(request.out, "site.json"))), metadata: hash(readFileSync(metadataPath)) }, immutable, "Browser coverage artifact changed during execution");
    } };
}

/** Caller creates and removes this private staging only after its supervised child drains. */
export function stageBrowserGuestInterruption(verified: VerifiedBrowserGuestCoverage, directory: string): void {
  if (!verified.interruptionBundle) throw new Error("Interruption was not selected");
  verified.assertUnchanged();
  mkdirSync(directory);
  const selection = verified.selection.filter(item => item.owner === "engine-interruption");
  for (const name of requiredPrograms(selection)) writeFileSync(join(directory, name), programBytes(verified.programs, name), { flag: "wx", mode: 0o400 });
}
