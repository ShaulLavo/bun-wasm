// Live driver for tests/fixtures/io-resource-context: runs the five-owner callback rows in one
// explicitly named guest and evaluates every row's observed frames. It never selects dist/ or builds.
//
//   bun scripts/io-resource-context.ts --surface native --engine quickjs|jsc --guest PATH
//     --launcher PATH --shell PATH --env-utility PATH --out DIR [--qualify HEAD TREE] [row...]
//   bun scripts/io-resource-context.ts --surface chromium --web-root DIR --out DIR [--qualify HEAD TREE] [row...]
//   bun scripts/io-resource-context.ts --surface node-host --guest PATH --context hooks|native --out DIR [row...]
//   bun scripts/io-resource-context.ts --surface host-bun --out DIR [row...]
//
// `--qualify` verifies original receipts against the selected source. node-host and host-bun are
// controls and never qualify. docs: .internal/io-resource-context-qualification.md
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt.ts";
import { guestBuilds } from "./guest-source-manifest.ts";
import { verifyLauncher } from "./producer-closure.ts";
import { RESULT_FILE, isRowId, rowIds, rows, unqualified, type Expected, type ExpectedFrame, type Frame, type Observation, type RowId } from "../tests/fixtures/io-resource-context/rows.ts";

const RESULT_SCHEMA ="bun-wasm.io-resource-context.result.v1";
const root = resolve(import.meta.dir, "..");
const fixture = join(root, "tests/fixtures/io-resource-context");
const ROW_BUDGET_MS = 30_000;
const CHROMIUM_TMP_LIMIT = 48;

type NativeEngine = "quickjs" | "jsc";
type Surface =
  | { readonly kind: "native"; readonly engine: NativeEngine; readonly guest: string; readonly launcher: string; readonly shell: string; readonly envUtility: string }
  | { readonly kind: "chromium"; readonly webRoot: string }
  | { readonly kind: "node-host"; readonly guest: string; readonly context: "hooks" | "native" }
  | { readonly kind: "host-bun" };
type Evidence ={ readonly kind: "qualification"; readonly head: string; readonly tree: string } | { readonly kind: "source-check" };
export interface Invocation { readonly surface: Surface; readonly evidence: Evidence; readonly out: string; readonly rows: readonly RowId[] }
/** Root on every hook-path turn; an unspecified ambient frame with a native continuation provider. */
export type ContextClass = "hooks" | "native";

interface FileIdentity { readonly role: string; readonly path: string; readonly sha256: string; readonly bytes: number }
interface RowReport { readonly id: string; readonly records: readonly Observation[]; readonly settled: number; readonly armed: boolean | null; readonly error: string | null; readonly execPath: string }
export interface RowRun { readonly id: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly report: RowReport | null; readonly stderr: string }
export interface GuestResult { readonly execPath: string; readonly rows: readonly RowRun[] }
type RowStatus ="pass" | "missing" | "hung" | "error" | "exit" | "unarmed" | "late" | "mismatch";
export interface RowVerdict { readonly id: RowId; readonly owner: string; readonly status: RowStatus; readonly reasons: readonly string[]; readonly observed: readonly Observation[] | null }

const usage = "usage: io-resource-context.ts --surface native|chromium|node-host|host-bun --out DIR [--qualify HEAD TREE] [surface options] [row...]";

function take(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required. ${usage}`);
  args.splice(index, 2);
  return value;
}

function explicitFile(path: string, name: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${name} does not exist: ${absolute}`);
  return absolute;
}

function parseSurface(args: string[], kind: string): Surface {
  if (kind === "host-bun") return { kind };
  if (kind === "chromium") return { kind, webRoot: explicitFile(take(args, "--web-root"), "--web-root") };
  if (kind === "node-host") {
    const context = take(args, "--context");
    if (context !== "hooks" && context !== "native") throw new Error(`--context must be hooks or native. ${usage}`);
    return { kind, guest: explicitFile(take(args, "--guest"), "--guest"), context };
  }
  if (kind !== "native") throw new Error(`unknown surface ${kind}. ${usage}`);
  const engine = take(args, "--engine");
  if (engine !== "quickjs" && engine !== "jsc") throw new Error(`--engine must be quickjs or jsc. ${usage}`);
  return {
    kind, engine, guest: explicitFile(take(args, "--guest"), "--guest"), launcher: explicitFile(take(args, "--launcher"), "--launcher"),
    shell: explicitFile(take(args, "--shell"), "--shell"), envUtility: explicitFile(take(args, "--env-utility"), "--env-utility"),
  };
}

function parseEvidence(args: string[]): Evidence {
  const index = args.indexOf("--qualify");
  if (index < 0) return { kind: "source-check" };
  const [head, tree] = args.splice(index, 3).slice(1);
  if (!head || !/^[0-9a-f]{40}$/.test(head) || !tree || !/^[0-9a-f]{40}$/.test(tree)) throw new Error(`--qualify needs a 40-hex head and tree. ${usage}`);
  return { kind: "qualification", head, tree };
}

export function parseInvocation(argv: readonly string[]): Invocation {
  const args = argv.slice();
  const evidence = parseEvidence(args);
  const surface = parseSurface(args, take(args, "--surface"));
  const out = resolve(take(args, "--out"));
  if (evidence.kind === "qualification" && (surface.kind === "node-host" || surface.kind === "host-bun")) throw new Error(`${surface.kind} is a control and cannot qualify`);
  const unknown = args.find(arg => arg.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}. ${usage}`);
  for (const name of args) if (!isRowId(name)) throw new Error(`unknown row ${name}`);
  return { surface, evidence, out, rows: args.length ? args.filter(isRowId) : rowIds };
}

function contextClass(surface: Surface): ContextClass {
  if (surface.kind === "chromium") return "hooks";
  if (surface.kind === "node-host") return surface.context;
  return "native";
}

function identity(role: string, path: string): FileIdentity {
  const bytes = readFileSync(path);
  return { role, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

// ---- evaluation ----------------------------------------------------------------------------

function frameMatches(expected: ExpectedFrame, actual: Frame, mode: ContextClass): boolean {
  if (expected === null || typeof expected === "string") return expected === actual;
  if (mode === "hooks") return actual === null;
  return !expected.turn.includes(actual);
}

function recordMatches(expected: Expected, actual: Observation, mode: ContextClass): boolean {
  const [site, frame, ...values] = expected;
  const [actualSite, actualFrame, ...actualValues] = actual;
  return site === actualSite && frameMatches(frame, actualFrame, mode) && isDeepStrictEqual(values, actualValues);
}

function sequenceMatches(expected: readonly Expected[], actual: readonly Observation[], mode: ContextClass): boolean {
  return expected.length === actual.length && expected.every((record, index) => recordMatches(record, actual[index]!, mode));
}

function siteMismatches(expected: readonly Expected[], actual: readonly Observation[], mode: ContextClass, sequence: readonly string[]): string[] {
  const reasons: string[] = [];
  const sites = new Set(expected.map(record => record[0]));
  for (const record of actual) if (!sites.has(record[0])) reasons.push(`unexpected callback ${JSON.stringify(record)}`);
  for (const site of sites) {
    const wanted = expected.filter(record => record[0] === site);
    if (!sequenceMatches(wanted, actual.filter(record => record[0] === site), mode)) reasons.push(`site ${site} differs from ${JSON.stringify(wanted)}`);
  }
  const firsts = sequence.map(site => actual.findIndex(record => record[0] === site));
  if (firsts.some((index, position) => index < 0 || (position > 0 && index < firsts[position - 1]!))) reasons.push(`first callbacks not in order ${sequence.join(" < ")}`);
  return reasons;
}

function compareRecords(id: RowId, actual: readonly Observation[], mode: ContextClass): string[] {
  const row = rows[id];
  if (row.order.kind === "sites") return siteMismatches(row.expect, actual, mode, row.order.sequence);
  return sequenceMatches(row.expect, actual, mode) ? [] : [`expected ${JSON.stringify(row.expect)} in order`];
}

function failure(id: RowId, status: RowStatus, reasons: readonly string[], observed: readonly Observation[] | null): RowVerdict {
  return { id, owner: rows[id].owner, status, reasons, observed };
}

/** Pure: one verdict per requested row. Anything but `pass` makes the run fail. */
export function evaluateRow(id: RowId, run: RowRun | undefined, mode: ContextClass): RowVerdict {
  if (!run) return failure(id, "missing", ["row never ran"], null);
  if (run.timedOut) return failure(id, "hung", ["row process did not exit by itself within its budget", run.stderr], run.report?.records ?? null);
  const report = run.report;
  if (!report || report.id !== id) return failure(id, "missing", ["row printed no report", run.stderr], null);
  if (report.error !== null) return failure(id, "error", [report.error], report.records);
  if (run.exitCode !== 0) return failure(id, "exit", [`row exited ${run.exitCode}`, run.stderr], report.records);
  if ("armed" in rows[id] && report.armed !== true) return failure(id, "unarmed", ["blocked operation completed before its checkpoint; completion frame not claimable"], report.records);
  const late = report.records.slice(report.settled);
  if (late.length) return failure(id, "late", [`callbacks after the row finished: ${JSON.stringify(late)}`], report.records);
  const reasons = compareRecords(id, report.records, mode);
  return failure(id, reasons.length ? "mismatch" : "pass", reasons, report.records);
}

function evaluate(result: GuestResult, requested: readonly RowId[], mode: ContextClass): RowVerdict[] {
  return requested.map(id => evaluateRow(id, result.rows.find(run => run.id === id), mode));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRowReport(value: unknown): RowReport | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.records) || typeof value.settled !== "number") return null;
  const records = value.records.filter((record): record is Observation => Array.isArray(record) && typeof record[0] === "string" && (record[1] === null || typeof record[1] === "string"));
  if (records.length !== value.records.length) return null;
  const armed = typeof value.armed === "boolean" ? value.armed : null;
  return { id: value.id, records, settled: value.settled, armed, error: typeof value.error === "string" ? value.error : null, execPath: String(value.execPath) };
}

function parseRowRun(value: unknown): RowRun | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const exitCode = typeof value.exitCode === "number" ? value.exitCode : null;
  return { id: value.id, exitCode, timedOut: value.timedOut === true, report: parseRowReport(value.report), stderr: String(value.stderr ?? "") };
}

/** Parses the fixture's result file, the guest/host boundary. */
export function parseGuestResult(text: string): GuestResult {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.rows)) throw new Error("io-resource-context result has no rows");
  const runs = value.rows.map(parseRowRun);
  if (runs.some(run => run === null)) throw new Error("io-resource-context result has a malformed row");
  return { execPath: String(value.execPath), rows: runs.filter(run => run !== null) };
}

// ---- execution -----------------------------------------------------------------------------

interface Execution { readonly code: number | null; readonly timedOut: boolean; readonly resultText: string | null; readonly loaded: readonly FileIdentity[]; readonly cleanup: Record<string, unknown> }

function stageFixture(work: string): FileIdentity[] {
  mkdirSync(work, { recursive: true });
  const names = readdirSync(fixture).filter(name => name.endsWith(".ts")).sort();
  for (const name of names) copyFileSync(join(fixture, name), join(work, name));
  return names.map(name => identity("fixture", join(fixture, name)));
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runGroup(command: string, args: readonly string[], cwd: string, out: string, budgetMs: number): Promise<{ code: number | null; timedOut: boolean; groupGone: boolean }> {
  const { stopProcessGroup } = await import("../web/tests/next-framework-process.ts");
  const child: ChildProcess = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", chunk => { log += String(chunk); });
  child.stderr?.on("data", chunk => { log += String(chunk); });
  const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
  const stop = () => void stopProcessGroup(child);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, budgetMs);
  let code: number | null;
  try {
    code = await exited;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await stopProcessGroup(child);
    writeFileSync(join(out, "guest.log"), log);
  }
  return { code, timedOut, groupGone: child.pid === undefined || !groupAlive(child.pid) };
}

function hostArgs(surface: Exclude<Surface, { kind: "chromium" }>, work: string, rows: readonly RowId[]): [string, string[]] {
  const entry = ["run", "/index.ts"].concat(rows);
  const common = ["--dir", `${work}::/`, "--env", "PWD=/", "--env", "HOME=/"];
  if (surface.kind === "host-bun") return [process.execPath, ["run", join(work, "index.ts")].concat(rows)];
  if (surface.kind === "node-host") return ["node", ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", surface.guest, "--context", surface.context].concat(common, ["--"], entry)];
  return [surface.launcher, ["--wasm", surface.guest, "--engine", `${surface.engine}=${surface.guest}`, "--shell", surface.shell, "--env-utility", surface.envUtility,
    "--env", `PATH=/opt/bun/${surface.engine}/bin:/bin:/usr/bin`].concat(common, ["--"], entry)];
}

async function runHost(surface: Exclude<Surface, { kind: "chromium" }>, invocation: Invocation, work: string): Promise<Execution> {
  const [command, args] = hostArgs(surface, work, invocation.rows);
  const run = await runGroup(command, args, work, invocation.out, (invocation.rows.length + 2) * ROW_BUDGET_MS);
  const resultPath = join(work, RESULT_FILE);
  const resultText = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : null;
  return { code: run.code, timedOut: run.timedOut, resultText, loaded: [], cleanup: { processGroupGone: run.groupGone } };
}

function shortTmp(): string {
  const scratch = realpathSync(process.env.BUN_WASM_TEST_TMP ?? tmpdir());
  if (scratch.length > CHROMIUM_TMP_LIMIT) throw new Error(`Chromium scratch ${scratch} exceeds ${CHROMIUM_TMP_LIMIT} bytes; set TMPDIR or BUN_WASM_TEST_TMP to a short owned directory`);
  return scratch;
}

async function runChromium(webRoot: string, invocation: Invocation, work: string): Promise<Execution> {
  shortTmp();
  const { playwright, ready, run, session, writeFile } = await import("../web/tests/playground.mjs");
  const s = session("bun-wasm-iorc-");
  const loaded: FileIdentity[] = [];
  try {
    const [, url] = await s.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { PORT: "0", ROOT: webRoot });
    const browser = await s.launch(playwright.chromium);
    const context = await browser.newContext();
    context.on("response", response => void recordLoaded(response, loaded));
    const page = await context.newPage();
    await page.goto(`${url}?engine=browser&prompt=off`);
    const status = await ready(page);
    if (!/ready · Browser \(native\)/.test(status)) throw new Error(`page did not select the Browser engine: ${status}`);
    for (const name of readdirSync(work)) await writeFile(page, `/home/user/io-resource-context/${name}`, readFileSync(join(work, name), "utf8"));
    const command = ["bun run io-resource-context/index.ts"].concat(invocation.rows).join(" ");
    const result = await run(page, command, (invocation.rows.length + 2) * ROW_BUDGET_MS);
    writeFileSync(join(invocation.out, "guest.log"), result.output);
    const read = `(async () => new TextDecoder().decode(await playground.fs.readFile(${JSON.stringify(`/home/user/io-resource-context/${RESULT_FILE}`)})))()`;
    const resultText = await page.evaluate(read).then(String, () => null);
    await context.close();
    return { code: result.code, timedOut: result.code === null, resultText, loaded, cleanup: { browserClosed: true } };
  } finally {
    await s.cleanup();
  }
}

async function recordLoaded(response: { url(): string; body(): Promise<Buffer> }, loaded: FileIdentity[]): Promise<void> {
  const url = response.url();
  if (!/\.(?:wasm|m?js)$/.test(new URL(url).pathname)) return;
  const bytes = await response.body().catch(() => null);
  if (!bytes) return;
  loaded.push({ role: "loaded", path: url, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
}

// ---- admission -----------------------------------------------------------------------------

const nativeArtifacts = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm" } as const;

async function admitNative(surface: Extract<Surface, { kind: "native" }>, evidence: Evidence): Promise<{ artifacts: FileIdentity[]; receipts: unknown[] }> {
  const artifacts = [identity("guest", surface.guest), identity("launcher", surface.launcher), identity("shell", surface.shell), identity("env-utility", surface.envUtility)];
  if (evidence.kind !== "qualification") return { artifacts, receipts: [] };
  const receiptPath = `${surface.guest}.build.json`;
  const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  verifyGuestBuildReceipt(readFileSync(surface.guest), receipt);
  if (basename(surface.guest) !== nativeArtifacts[surface.engine] || guestBuilds[receipt.sourceManifest.build].artifact !== nativeArtifacts[surface.engine]) throw new Error(`guest is not the ${surface.engine} build`);
  const source = receipt.sourceManifest.source;
  if (source.head !== evidence.head || source.tree !== evidence.tree) throw new Error(`guest source ${source.head}/${source.tree} is not the selected ${evidence.head}/${evidence.tree}`);
  await verifyGuestCompanions(receipt, dirname(surface.guest));
  const launcherReceiptPath = `${surface.launcher}.launcher.json`;
  verifyLauncher(surface.launcher, JSON.parse(readFileSync(launcherReceiptPath, "utf8")), evidence);
  return {
    artifacts: artifacts.concat(identity("guest-receipt", receiptPath), identity("launcher-receipt", launcherReceiptPath)),
    receipts: [{ guest: receiptPath, program: receipt.program, sourceManifestSha256: receipt.sourceManifestSha256 }],
  };
}

function admitChromium(webRoot: string): FileIdentity[] {
  const registry = join(webRoot, "engine-builds.json");
  if (!existsSync(registry)) throw new Error(`web root has no engine-builds.json: ${webRoot}`);
  return [identity("engine-builds", registry), identity("index", join(webRoot, "index.html"))];
}

// ---- main ----------------------------------------------------------------------------------

function resultStatus(surface: Surface, verdicts: readonly RowVerdict[], execution: Execution, parsed: GuestResult | null): "pass" | "fail" {
  if (!parsed || execution.timedOut || execution.code !== 0) return "fail";
  if (surface.kind === "chromium" && !execution.loaded.some(file => new URL(file.path).pathname.endsWith(".wasm"))) return "fail";
  return verdicts.every(verdict => verdict.status === "pass") ? "pass" : "fail";
}

async function execute(invocation: Invocation, work: string): Promise<Execution> {
  const { surface } = invocation;
  if (surface.kind === "chromium") return await runChromium(surface.webRoot, invocation, work);
  return await runHost(surface, invocation, work);
}

export async function main(argv: readonly string[]): Promise<number> {
  const invocation = parseInvocation(argv);
  mkdirSync(invocation.out, { recursive: true });
  const work = join(invocation.out, "work");
  if (existsSync(work)) throw new Error(`output already has a work directory: ${work}`);
  const { surface, evidence } = invocation;
  const admitted = surface.kind === "native" ? await admitNative(surface, evidence) : { artifacts: surface.kind === "chromium" ? admitChromium(surface.webRoot) : [], receipts: [] };
  const fixtureFiles = stageFixture(work);
  let execution: Execution;
  try {
    execution = await execute(invocation, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const parsed = execution.resultText === null ? null : parseGuestResult(execution.resultText);
  const verdicts = parsed ? evaluate(parsed, invocation.rows, contextClass(surface)) : invocation.rows.map(id => evaluateRow(id, undefined, contextClass(surface)));
  const status = resultStatus(surface, verdicts, execution, parsed);
  const result = {
    schema: RESULT_SCHEMA, status, surface, contextClass: contextClass(surface), evidence,
    qualification: evidence.kind === "qualification" && status === "pass",
    artifacts: admitted.artifacts, receipts: admitted.receipts, loaded: execution.loaded, fixture: fixtureFiles,
    guest: { exitCode: execution.code, timedOut: execution.timedOut, execPath: parsed?.execPath ?? null, rowExecPaths: parsed?.rows.map(run => run.report?.execPath ?? null) ?? [] },
    rows: verdicts, unqualified,
    cleanup: { ...execution.cleanup, workRemoved: !existsSync(work) },
  };
  writeFileSync(join(invocation.out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  for (const verdict of verdicts) console.log(`${verdict.status === "pass" ? "PASS" : "FAIL"} ${verdict.id}${verdict.status === "pass" ? "" : ` (${verdict.status}) ${verdict.reasons[0] ?? ""}`}`);
  console.log(`${status.toUpperCase()} io-resource-context ${surface.kind}${surface.kind === "native" ? `/${surface.engine}` : ""}: ${verdicts.filter(verdict => verdict.status === "pass").length}/${verdicts.length} rows`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
