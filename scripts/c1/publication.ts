import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pinnedBashWeb, verifiedGuests } from "../bash-web-guests.ts";
import { captureProgramInputs, type ProgramInputSnapshot } from "../guest-core-receipt.ts";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, verifyGuestCompanions } from "../guest-build-receipt.ts";
import { sourceOptions, type GuestBuild } from "../guest-source-manifest.ts";
import { prepareGuest } from "../guest-artifact.ts";
import { verifyPublicationInputs } from "../guest-acceptance.ts";
import {
  handoffMemberPaths, producerArtifactPaths, producerScopes, producerSelection, publicationAssets, publicationGuestPaths, requireCompletePublicationFiles,
  selectedReleaseArchives, verifyPublicationBuilds, verifyPublicationNativeBacking,
} from "../producer-closure.ts";
import type { ProcessOwner } from "../process-owner.mts";
import { DELIVERY_RECORDS, type FileIdentity, type InputManifest, type SourceIdentity } from "./contract.ts";
import { deliveryMembers } from "./delivery.ts";
import { fileIdentity, requireFile, sameBytes } from "./identity.ts";
import { cleanSource, git } from "./inputs.ts";
import { runOwned } from "./process.ts";
import { BROWSER_TMPDIR_LIMIT } from "./roots.ts";

class PublicationError extends Error {}
function fail(message: string): never { throw new PublicationError(message); }

/** Everything a publication step reads; built once per operation. */
export interface PublicationContext {
  readonly source: SourceIdentity;
  readonly sourceRoot: string;
  readonly manifest: InputManifest;
  /** Root holding `split/`, `publication/` and later `delivery/`. */
  readonly artifact: string;
  readonly report: string;
  readonly browserTmp: string;
  readonly env: Readonly<Record<string, string>>;
  readonly owner: ProcessOwner;
  /** Raw bytes of the config, input manifest and environment record this run delivers. */
  readonly records: { readonly config: Uint8Array; readonly inputs: Uint8Array; readonly environment: Uint8Array };
}
const PHASES = ["before", "after", "preseal"] as const;
export type Phase = typeof PHASES[number];
const NATIVE_COPIES = [".bunwasm-artifacts", "build/jsc/.bunwasm-inputs", "build/jsc/CMakeCache.txt", "build/jsc/cmakeconfig.h", "build/jsc/compile_commands.json",
  "inputs/wasi-jsc.cmake", "inputs/shim/wasi-compat.h", "inputs/shim/wasi-compat.c", "inputs/shim/madvise.c"];
const NATIVE_GROUPS = ["jsc-prebuild", "sdk", "sysroot", "jsc-helper-sdk-headers", "jsc-helper-sysroot-headers"];
/** Recipe logs that must exist with exit 0 before a delivery is complete. */
const REQUIRED_GATES =["native-before.log", "browser-producer.log", "source-cache-browser-producer.log", "tools-producer.log", "split-producer.log", "jsc-embedding.log",
  "web-guests.log", "source-cache-web-guests.log", "publication-inputs.log", "publication-matrix.log", "split-verify.log", "native-after.log", "native-preseal.log"];

const publication = (context: PublicationContext, ...parts: string[]) => join(context.artifact, "publication", ...parts);
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function field(value: unknown, key: string): unknown { return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined; }
function save(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
/** A new copy that must not exist yet, byte-checked. */
function copyNew(from: string, to: string): void {
  if (lstatSync(to, { throwIfNoEntry: false })) fail(`publication destination exists: ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  if (!sameBytes(fileIdentity(to), fileIdentity(from))) fail(`publication copy differs: ${to}`);
}
/**
 * Replace a task-owned staged file atomically. Admitted originals can be 0444
 * and a copy keeps that mode, so a later stage could not reopen it: write a
 * fresh 0644 file beside the destination and rename it over. The source keeps
 * its bytes, mode and inode.
 */
export function restage(from: string, to: string): void {
  const existing = lstatSync(to, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) fail(`staged destination is not a regular file: ${to}`);
  const temporary = join(dirname(to), `.${basename(to)}.c1-staging`);
  copyFileSync(from, temporary, constants.COPYFILE_EXCL);
  chmodSync(temporary, 0o644);
  renameSync(temporary, to);
  if (!sameBytes(fileIdentity(to), fileIdentity(from))) fail(`staged copy differs: ${to}`);
}
function files(root: string, path = ""): { path: string; bytes: number; sha256: string }[] {
  return readdirSync(join(root, path)).sort().flatMap(name => {
    const member = path ? `${path}/${name}` : name;
    const stat = lstatSync(join(root, member));
    if (stat.isDirectory()) return files(root, member);
    if (!stat.isFile()) fail(`not a regular file: ${join(root, member)}`);
    const identity = fileIdentity(join(root, member));
    return [{ path: member, bytes: identity.bytes, sha256: identity.sha256 }];
  });
}

function headerManifest(manifest: InputManifest): FileIdentity {
  const provenance = manifest.native.jsc.provenance;
  const header = provenance.status === "verified" ? provenance.receipts.find(file => basename(file.path) === "native-header-manifest.json") : undefined;
  if (!header) fail("verified JSC provenance must name its original native-header-manifest.json");
  return header;
}
/** Original inputs every delivery retains: records, vendor bundle, native evidence, release archives, fd3. */
export function initialize(context: PublicationContext): void {
  cleanSource(context.sourceRoot);
  const { manifest } = context;
  for (const [name, bytes] of Object.entries(context.records)) {
    const path = publication(context, DELIVERY_RECORDS[name as keyof typeof context.records]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  const vendor = join(context.sourceRoot, "vendor/bun");
  const upstream = /\nBUN_COMMIT=([a-f0-9]{40})\n/.exec(readFileSync(join(context.sourceRoot, "scripts/sync-bun.sh"), "utf8"))?.[1] ?? fail("Bun base pin missing");
  const bundle = publication(context, "inputs/vendor-bun.bundle");
  mkdirSync(dirname(bundle), { recursive: true });
  git(vendor, ["bundle", "create", bundle, "HEAD", `^${upstream}`]);
  git(vendor, ["bundle", "verify", bundle]);
  save(publication(context, "inputs/vendor-bundle-proof.json"), { head: git(vendor, ["rev-parse", "HEAD"]), tree: git(vendor, ["rev-parse", "HEAD^{tree}"]), upstreamPrerequisite: upstream, bundle: fileIdentity(bundle) });
  for (const path of NATIVE_COPIES) copyNew(join(manifest.native.jsc.root, path), publication(context, "native/jsc", path === "build/jsc/.bunwasm-inputs" ? ".bunwasm-inputs" : path));
  copyNew(requireFile(headerManifest(manifest), "native header manifest").path, publication(context, "native/jsc/native-header-manifest.json"));
  const archives = selectedReleaseArchives();
  const paths = handoffMemberPaths();
  const retained: [FileIdentity, string][] = [[manifest.runtime.archive, archives.runtime.path], [manifest.relay.archive, archives.relay.path],
    [manifest.programs.manifest, paths.programManifest], [manifest.programs.checksums, paths.programChecksums], [manifest.fd3.artifact, paths.fd3Artifact], [manifest.fd3.receipt, paths.fd3Receipt]];
  for (const [file, path] of retained) copyNew(requireFile(file, path).path, publication(context, path));
}

async function sourceCapture(context: PublicationContext) {
  const sysroot = context.manifest.native.sysroot.root;
  const guests: Partial<Record<GuestBuild, unknown>> = {};
  for (const build of ["browser", "source-cache-browser", "tools"] as const) guests[build] = await prepareGuestBuildInputs(sourceOptions(context.sourceRoot, sysroot, build));
  const components: ProgramInputSnapshot[] = [];
  for (const scope of producerScopes("split")) {
    components.push(await captureProgramInputs(sourceOptions(context.sourceRoot, sysroot, scope === "core" ? "browser" : scope), scope, scope === "core" ? producerSelection("split") : undefined));
  }
  return { source: context.source, guests, components };
}
function vendorCustody(context: PublicationContext) {
  const vendor = join(context.sourceRoot, "vendor/bun");
  const status = git(vendor, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) fail("vendor/bun changed during production");
  return { head: git(vendor, ["rev-parse", "HEAD"]), tree: git(vendor, ["rev-parse", "HEAD^{tree}"]), bundle: fileIdentity(publication(context, "inputs/vendor-bun.bundle")),
    generated: files(join(vendor, "build/debug/codegen")) };
}
function nativeCustody(context: PublicationContext) {
  const { jsc, sysroot } = context.manifest.native;
  for (const file of jsc.files.concat(sysroot.files)) requireFile(file, "native backing");
  verifyPublicationNativeBacking({ jsc: jsc.root, sysroot: sysroot.root });
  const paths = NATIVE_COPIES.map(path => join(jsc.root, path)).concat([join(jsc.root, "jsc.wasm"), join(sysroot.root, "bun-wasm-sysroot.json"), headerManifest(context.manifest).path]);
  return { backing: { jsc: jsc.root, sysroot: sysroot.root }, files: paths.map(path => fileIdentity(path)) };
}
function nativeHeaderAdmission(context: PublicationContext, components: readonly ProgramInputSnapshot[]): void {
  const header = headerManifest(context.manifest);
  const groups = field(json(header.path), "groups");
  const current = field(components.find(component => component.scope === "jsc")?.content, "groups");
  if (!Array.isArray(groups) || !Array.isArray(current)) fail("native header groups are missing");
  for (const name of NATIVE_GROUPS) {
    const origin: unknown = groups.find(group => field(group, "name") === name);
    const selected: unknown = current.find(group => field(group, "name") === name);
    if (["jsc-prebuild", "sdk", "sysroot"].includes(name) && (!origin || !selected)) fail(`native group ${name} is missing`);
    if (JSON.stringify(selected) !== JSON.stringify(origin)) fail(`native group ${name} differs from the original header manifest`);
  }
  save(publication(context, "inputs/NATIVE-CANDIDATE-ADMISSION.json"), { nativeRoot: context.manifest.native.jsc.root, originalHeaderManifest: header, groupsCompared: NATIVE_GROUPS });
}
/** Source, vendor and native inputs, captured in E. Every later phase must equal `before`. */
export async function capture(context: PublicationContext, phase: Phase): Promise<void> {
  cleanSource(context.sourceRoot);
  const captured = await sourceCapture(context);
  const values: Record<string, unknown> = { [`${phase}.json`]: captured, [`vendor-custody-${phase}.json`]: vendorCustody(context), [`native-custody-${phase}.json`]: nativeCustody(context) };
  for (const [name, value] of Object.entries(values)) {
    const before = publication(context, "inputs", name.replace(phase, "before"));
    if (phase !== "before" && JSON.stringify(value) !== JSON.stringify(json(before))) fail(`${name} differs from the original capture`);
    save(publication(context, "inputs", name), value);
  }
  const consumer = browserConsumer(context);
  const consumerPath = publication(context, "inputs/browser-consumer.json");
  if (phase === "before") save(consumerPath, consumer);
  if (phase !== "before" && JSON.stringify(consumer) !== JSON.stringify(json(consumerPath))) fail("installed browser consumer changed");
  if (phase === "before") nativeHeaderAdmission(context, captured.components);
}
function browserConsumer(context: PublicationContext) {
  const installed = realpathSync(join(context.sourceRoot, "web/node_modules/waffle"));
  const metadata = json(join(installed, "package.json"));
  if (field(metadata, "version") !== context.manifest.tuple.runtime || field(metadata, "waffleHostInterface") !== context.manifest.tuple.hostInterface) fail("installed Waffle is not the selected runtime");
  return { installed, metadata, files: files(installed) };
}

export function stageGuest(context: PublicationContext, build: "browser" | "tools"): void {
  const path = publicationGuestPaths[build];
  for (const suffix of ["", ".build.json"]) copyNew(join(context.sourceRoot, "dist", basename(path) + suffix), publication(context, path + suffix));
}
/** Restage the product `dist` a smoke variant consumes. Runs once per variant over the same originals. */
export function smokeInputs(context: Pick<PublicationContext, "sourceRoot" | "artifact">, variant: "default" | "source-cache" | "matrix"): void {
  const output = join(context.sourceRoot, "dist");
  mkdirSync(output, { recursive: true });
  const split = join(context.artifact, "split/dist");
  for (const file of readdirSync(split)) if (lstatSync(join(split, file)).isFile()) restage(join(split, file), join(output, file));
  const browser = join(context.artifact, "publication", variant === "source-cache" ? publicationGuestPaths["source-cache-browser"] : publicationGuestPaths.browser);
  for (const suffix of ["", ".build.json"]) restage(browser + suffix, join(output, `bun-browser.wasm${suffix}`));
  for (const suffix of ["", ".build.json"]) restage(join(context.artifact, "publication", publicationGuestPaths.tools + suffix), join(output, `bun-tools.wasm${suffix}`));
  if (variant !== "matrix") return;
  const matrix = join(context.artifact, "publication-matrix");
  for (const name of ["bun.wasm", "bun.wasm.build.json", "quickjs.wasm", "bun-jsc.wasm", "bun-jsc.wasm.build.json", "jsc-engine.wasm", "bun-browser.wasm", "bun-browser.wasm.build.json"]) {
    copyNew(join(output, name), join(matrix, name));
  }
}
export async function matrixInputs(context: PublicationContext): Promise<void> {
  const matrix = join(context.artifact, "publication-matrix");
  const guest = prepareGuest({ kind: "single", core: readFileSync(join(matrix, "bun-browser.wasm")) }, "https://bun-artifacts.shaulavo.dev");
  await verifyPublicationInputs(matrix, guest.descriptor);
}

/** The runner's live scratch: a direct physical child of the browser root, within the Chromium limit. */
export function verifyMatrixScratch(root: string, scratch: string) {
  if (dirname(scratch) !== root) fail(`matrix TMPDIR is outside the browser scratch root: ${scratch}`);
  if (!/^bun-wasm-engine-interruption-[A-Za-z0-9]{6}$/.test(basename(scratch))) fail(`unexpected matrix TMPDIR: ${scratch}`);
  const bytes = Buffer.byteLength(scratch);
  if (bytes > BROWSER_TMPDIR_LIMIT) fail(`matrix TMPDIR has ${bytes} bytes: ${scratch}`);
  if (realpathSync(scratch) !== scratch) fail(`matrix TMPDIR is not physical: ${scratch}`);
  return { root, scratch, bytes, limit: BROWSER_TMPDIR_LIMIT };
}
function reportedScratch(line: string): string | undefined {
  if (!line.startsWith("{\"resources\":")) return undefined;
  const scratch = field(field(JSON.parse(line), "resources"), "scratch");
  return typeof scratch === "string" ? scratch : undefined;
}
/** Run the product matrix runner, observing its scratch while it exists and stopping it on a violation. */
export async function publicationMatrix(context: PublicationContext, signal: AbortSignal, runner = join(context.sourceRoot, "web/tests/browser-engine-interruption.ts"), drain?: { graceMs: number; forceMs: number }): Promise<void> {
  if (readdirSync(context.browserTmp).length) fail("browser scratch root is not empty before the matrix");
  const local = new AbortController();
  const stop = () => local.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  let observed: ReturnType<typeof verifyMatrixScratch> | undefined;
  let refused: unknown;
  const onLine = (line: string) => {
    process.stdout.write(`${line}\n`);
    const scratch = observed || refused ? undefined : reportedScratch(line);
    if (!scratch) return;
    try { observed = verifyMatrixScratch(context.browserTmp, scratch); } catch (error) { refused = error; local.abort(error); }
  };
  const env = { ...context.env, TMPDIR: context.browserTmp, TMP: context.browserTmp, TEMP: context.browserTmp,
    BUN_WASM_INTERRUPTION_DIST: join(context.artifact, "publication-matrix"), ENGINE_INTERRUPTION_OUTPUT: publication(context, "inputs/publication-matrix.json") };
  try { await runOwned(context.owner, { argv: [context.env.BUN_EXE ?? process.execPath, runner, "chromium", "firefox", "webkit"], cwd: context.sourceRoot, env, onLine }, local.signal, drain); }
  catch (error) { throw refused ?? error; }
  finally { signal.removeEventListener("abort", stop); }
  if (!observed) fail("matrix runner never reported its TMPDIR");
  const leftovers = readdirSync(context.browserTmp);
  save(join(context.report, "publication-matrix-tmpdir.json"), { ...observed, removedByRunner: !existsSync(observed.scratch), leftovers });
  if (leftovers.length) fail("publication matrix left browser scratch");
}

/** Build the delivery tree: publication records, split closure, gate logs and stage index. */
export function stageDelivery(context: PublicationContext): string {
  const delivery = join(context.artifact, "delivery");
  if (existsSync(delivery)) fail("delivery already exists");
  for (const file of files(publication(context))) copyNew(publication(context, file.path), join(delivery, file.path));
  const split = join(context.artifact, "split");
  const listed = field(json(join(split, "manifest.json")), "files");
  if (!Array.isArray(listed)) fail("split manifest has no files");
  for (const entry of listed) requireFile({ path: join(split, String(field(entry, "path"))), bytes: Number(field(entry, "bytes")), sha256: String(field(entry, "sha256")) }, "split artifact");
  const paths = new Set(producerArtifactPaths("split").concat(["manifest.json", "hook-cleanup.json"], listed.map(entry => String(field(entry, "path")))));
  for (const path of paths) copyNew(join(split, path), join(delivery, "split", path));
  for (const name of REQUIRED_GATES.concat(["stages.json"])) copyNew(join(context.report, name), join(delivery, "proof", name));
  return delivery;
}

function verifyGates(delivery: string): void {
  const stages = json(join(delivery, DELIVERY_RECORDS.stages));
  for (const name of REQUIRED_GATES) if (field(field(stages, name), "exit") !== 0) fail(`required gate failed or missing: ${name}`);
  const matrix = json(join(delivery, "inputs/publication-matrix.json"));
  const reports = field(matrix, "reports");
  if (field(matrix, "ok") !== true || field(field(matrix, "cleanup"), "safe") !== true || !Array.isArray(reports)) fail("publication matrix did not pass with safe cleanup");
  if (reports.map(report => field(report, "browser")).sort().join(",") !== "chromium,firefox,webkit") fail("publication matrix lacks a browser");
  if (reports.some(report => field(report, "ok") !== true || field(field(report, "cleanup"), "safe") !== true)) fail("a publication matrix browser failed");
  const hook = json(join(delivery, "split/hook-cleanup.json"));
  if (field(hook, "serverExited") !== true || field(hook, "browserClosed") !== true) fail("hook smoke cleanup is incomplete");
}
async function verifyGuests(context: PublicationContext, delivery: string): Promise<void> {
  const before = field(json(join(delivery, "inputs/before.json")), "guests");
  for (const [build, path] of Object.entries(publicationGuestPaths)) {
    const receipt: unknown = json(join(delivery, `${path}.build.json`));
    verifyGuestBuildReceipt(readFileSync(join(delivery, path)), receipt);
    if (JSON.stringify(receipt.sourceManifest.source) !== JSON.stringify(context.source) || receipt.sourceManifest.build !== build) fail(`${build} guest receipt names another source or build`);
    if (receipt.sourceManifestSha256 !== field(field(before, build), "sourceManifestSha256")) fail(`${build} guest was built from other inputs than captured`);
    await verifyGuestCompanions(receipt, dirname(join(delivery, path)));
  }
  const builds = json(join(delivery, "split/web/engine-builds.json"));
  verifyPublicationBuilds(builds);
  if (JSON.stringify(builds) !== JSON.stringify(field(json(join(delivery, "split/manifest.json")), "engineBuilds"))) fail("served registry differs from the producer manifest");
  const paths = handoffMemberPaths();
  for (const name of publicationAssets) {
    const raw = name === "bun-browser.wasm" ? paths.browserGuest : name === "bun-tools.wasm" ? paths.toolsGuest : `split/dist/${name}`;
    const bytes = readFileSync(join(delivery, raw));
    if (fileIdentity(join(delivery, raw)).sha256 !== builds[name]) fail(`registry fingerprint differs for ${name}`);
    if (!Buffer.from(Bun.gunzipSync(readFileSync(join(delivery, "split/web", `${name}.gz`)))).equals(bytes)) fail(`served gzip differs from ${name}`);
  }
}
function verifyShell(context: PublicationContext, delivery: string): void {
  const guests = verifiedGuests(join(delivery, "split/dist"), pinnedBashWeb(join(context.sourceRoot, "web")));
  if (!guests) fail("delivery has no shell guests for the source's Bash pin");
  for (const guest of guests) if (!readFileSync(guest.path).equals(readFileSync(join(delivery, "split/web/programs", guest.program)))) fail(`served ${guest.program} differs from the admitted shell`);
}
/** Complete-publication gate over the staged delivery, before the single seal. */
export async function verifyDelivery(context: PublicationContext, delivery: string): Promise<void> {
  for (const prefix of ["", "vendor-custody-", "native-custody-"]) {
    const before = readFileSync(join(delivery, `inputs/${prefix}before.json`), "utf8");
    for (const phase of PHASES.slice(1)) if (readFileSync(join(delivery, `inputs/${prefix}${phase}.json`), "utf8") !== before) fail(`${prefix}${phase} custody changed`);
  }
  verifyGates(delivery);
  await verifyGuests(context, delivery);
  verifyShell(context, delivery);
  const paths = handoffMemberPaths();
  const retained: [FileIdentity, string][] = [[context.manifest.runtime.archive, paths.runtimeArchive], [context.manifest.relay.archive, paths.relayArchive],
    [context.manifest.programs.manifest, paths.programManifest], [context.manifest.fd3.artifact, paths.fd3Artifact], [context.manifest.fd3.receipt, paths.fd3Receipt]];
  for (const [file, path] of retained) if (!sameBytes(requireFile(file, path), fileIdentity(join(delivery, path)))) fail(`retained ${path} differs from its input`);
  requireCompletePublicationFiles(deliveryMembers(delivery));
  cleanSource(context.sourceRoot);
}
