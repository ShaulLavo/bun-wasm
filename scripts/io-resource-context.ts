// Live driver for tests/fixtures/io-resource-context: runs the five-owner callback rows in one
// explicitly named guest and evaluates every row's observed frames. It never selects dist/ or builds.
//
//   bun scripts/io-resource-context.ts --surface native --engine quickjs|jsc
//     --handoff PATH --handoff-sha256 SHA --out DIR [row...]
//   bun scripts/io-resource-context.ts --surface chromium --handoff PATH --handoff-sha256 SHA --out DIR [row...]
//   bun scripts/io-resource-context.ts --surface node-host --guest PATH --context hooks|native --out DIR [row...]
//   bun scripts/io-resource-context.ts --surface host-bun --out DIR [row...]
//
// Individual artifact paths remain source checks only. Controls never qualify.
// docs: .internal/io-resource-context-qualification.md
import { spawn, type ChildProcess } from "node:child_process";
import type { Browser, BrowserServer } from "playwright";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyLauncher } from "./producer-closure.ts";
import { expectedBrowserPayload, loadedObserver, type LoadedAsset } from "./io-resource-context-assets.ts";
import { bindFiveOwnerBrowser, bindFiveOwnerOutput, bindFiveOwnerSource, readFiveOwnerHandoff, readFiveOwnerMember, recheckFiveOwnerBrowser, recheckFiveOwnerHandoff, requireFiveOwnerMember, requireFiveOwnerResponse, verifyFiveOwnerGuest, type PinnedHandoff } from "./io-resource-context-intake.ts";
import { bindLoaded, type LoadedObservation } from "./c1/loaded.ts";
import { RESULT_FILE, isRowId, rowIds, rows, unqualified, type Expected, type ExpectedFrame, type Frame, type Observation, type RowId } from "../tests/fixtures/io-resource-context/rows.ts";
import { executable, parseRowReport, record, type RowReport } from "../tests/fixtures/io-resource-context/protocol.ts";

export const RESULT_SCHEMA ="bun-wasm.io-resource-context.result.v1";
const root = resolve(import.meta.dir, "..");
const fixture = join(root, "tests/fixtures/io-resource-context");
const ROW_BUDGET_MS = 30_000;
const CHROMIUM_TMP_LIMIT = 48;
const terminationSignals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

type NativeEngine = "quickjs" | "jsc";
type Surface =
  | { readonly kind: "native"; readonly engine: NativeEngine; readonly guest: string; readonly launcher: string; readonly shell: string; readonly envUtility: string }
  | { readonly kind: "chromium"; readonly webRoot: string }
  | { readonly kind: "node-host"; readonly guest: string; readonly context: "hooks" | "native" }
  | { readonly kind: "host-bun" };
type Evidence = PinnedHandoff | { readonly kind: "source-check" };
export interface Invocation { readonly surface: Surface; readonly evidence: Evidence; readonly out: string; readonly rows: readonly RowId[] }
/** Root on every hook-path turn; an unspecified ambient frame with a native continuation provider. */
export type ContextClass = "hooks" | "native";

interface FileIdentity { readonly role: string; readonly path: string; readonly sha256: string; readonly bytes: number }
export interface RowRun { readonly id: RowId; readonly exitCode: number | null; readonly timedOut: boolean; readonly report: RowReport | null; readonly stderr: string }
export interface GuestResult { readonly execPath: string; readonly rows: readonly RowRun[] }
type RowStatus ="pass" | "limited" | "missing" | "hung" | "error" | "exit" | "unarmed" | "late" | "mismatch";
export interface RowVerdict { readonly id: RowId; readonly owner: string; readonly status: RowStatus; readonly reasons: readonly string[]; readonly observed: readonly Observation[] | null }

const usage = "usage: io-resource-context.ts --surface native|chromium|node-host|host-bun --out DIR [--handoff PATH --handoff-sha256 SHA | explicit source-check paths] [surface options] [row...]";

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

function parseSurface(args: string[], kind: string, evidence: Evidence): Surface {
  if (kind === "host-bun") return { kind };
  if (kind === "chromium") return { kind, webRoot: evidence.kind === "handoff" ? evidence.handoff.webRoot : explicitFile(take(args, "--web-root"), "--web-root") };
  if (kind === "node-host") {
    const context = take(args, "--context");
    if (context !== "hooks" && context !== "native") throw new Error(`--context must be hooks or native. ${usage}`);
    return { kind, guest: explicitFile(take(args, "--guest"), "--guest"), context };
  }
  if (kind !== "native") throw new Error(`unknown surface ${kind}. ${usage}`);
  const engine = take(args, "--engine");
  if (engine !== "quickjs" && engine !== "jsc") throw new Error(`--engine must be quickjs or jsc. ${usage}`);
  if (evidence.kind === "handoff") {
    const artifacts = evidence.handoff.artifacts;
    return { kind, engine, guest: artifacts[engine === "quickjs" ? "quickjsGuest" : "jscGuest"].path,
      launcher: artifacts.launcher.path, shell: artifacts.shell.path, envUtility: artifacts.envUtility.path };
  }
  return {
    kind, engine, guest: explicitFile(take(args, "--guest"), "--guest"), launcher: explicitFile(take(args, "--launcher"), "--launcher"),
    shell: explicitFile(take(args, "--shell"), "--shell"), envUtility: explicitFile(take(args, "--env-utility"), "--env-utility"),
  };
}

function parseEvidence(args: string[], kind: string): Evidence {
  if (!args.includes("--handoff")) return { kind: "source-check" };
  if (kind === "host-bun" || kind === "node-host") throw new Error(`${kind} is a control and cannot qualify`);
  return readFiveOwnerHandoff(take(args, "--handoff"), take(args, "--handoff-sha256"));
}

function bindBrowserInvocation(pinned: PinnedHandoff): void {
  bindFiveOwnerBrowser(pinned, root);
  if (shortTmp() !== realpathSync(pinned.handoff.browserTmp)) throw new Error("Browser scratch differs from the handoff");
}

export function parseInvocation(argv: readonly string[]): Invocation {
  const args = argv.slice();
  const kind = take(args, "--surface");
  const evidence = parseEvidence(args, kind);
  const surface = parseSurface(args, kind, evidence);
  const out = resolve(take(args, "--out"));
  if (evidence.kind === "handoff") {
    const selected = surface.kind === "native" ? surface.engine : "chromium";
    bindFiveOwnerOutput(evidence, selected, out);
    bindFiveOwnerSource(evidence, root);
    if (surface.kind === "chromium") bindBrowserInvocation(evidence);
  }
  const unknown = args.find(arg => arg.startsWith("--"));
  if (unknown) throw new Error(`unknown option ${unknown}. ${usage}`);
  for (const name of args) if (!isRowId(name)) throw new Error(`unknown row ${name}`);
  if (new Set(args).size !== args.length) throw new Error("duplicate requested row");
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
    const observed = actual.filter(record => record[0] === site);
    if (!sequenceMatches(wanted, observed, mode)) reasons.push(`site ${site} differs from ${JSON.stringify(wanted)}`);
  }
  const firsts = sequence.map(site => actual.findIndex(record => record[0] === site));
  if (firsts.some((index, position) => index < 0 || (position > 0 && index < firsts[position - 1]!))) reasons.push(`first callbacks not in order ${sequence.join(" < ")}`);
  return reasons;
}

function compareRecords(id: RowId, actual: readonly Observation[], mode: ContextClass): string[] {
  const row = rows[id];
  const order = row.order;
  if (order.kind === "sites") {
    const reasons = siteMismatches(row.expect, actual, mode, order.sequence);
    const drained = "drainedBefore" in order ? order.drainedBefore : undefined;
    const lastMessage = drained ? actual.findLastIndex(item => item[0] === drained[0]) : -1;
    const disconnect = drained ? actual.findIndex(item => item[0] === drained[1]) : 0;
    if (drained && lastMessage >= disconnect) reasons.push("not every message preceded disconnect");
    return reasons;
  }
  return sequenceMatches(row.expect, actual, mode) ? [] : [`expected ${JSON.stringify(row.expect)} in order`];
}

function failure(id: RowId, status: RowStatus, reasons: readonly string[], observed: readonly Observation[] | null): RowVerdict {
  return { id, owner: rows[id].owner, status, reasons, observed };
}

/** Pure: exact rows pass; native turn-exclusion rows remain limited, not exact evidence. */
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
  if (reasons.length) return failure(id, "mismatch", reasons, report.records);
  const limited = mode === "native" && rows[id].expect.some(item => typeof item[1] === "object" && item[1] !== null);
  return failure(id, limited ? "limited" : "pass", limited ? ["Native turn exclusion only; exact turn-frame preservation is unqualified"] : [], report.records);
}

function evaluate(result: GuestResult, requested: readonly RowId[], mode: ContextClass): RowVerdict[] {
  return requested.map(id => evaluateRow(id, result.rows.find(run => run.id === id), mode));
}

function parseRowRun(value: unknown): RowRun {
  const data = record(value);
  if (typeof data.id !== "string" || !isRowId(data.id)) throw new Error("malformed row identity");
  const exitCode = data.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) throw new Error("malformed row exit code");
  if (typeof data.timedOut !== "boolean" || typeof data.stderr !== "string") throw new Error("malformed row execution fields");
  const report = data.report === null ? null : parseRowReport(data.report);
  if (report && report.id !== data.id) throw new Error("malformed row report identity");
  return { id: data.id, exitCode, timedOut: data.timedOut, report, stderr: data.stderr };
}

/** Parses the fixture's result file, the guest/host boundary. */
export function parseGuestResult(text: string, requested?: readonly RowId[], permittedExecPaths?: readonly string[]): GuestResult {
  const value = record(JSON.parse(text));
  if (!Array.isArray(value.rows)) throw new Error("io-resource-context result has no rows");
  const runs = value.rows.map(parseRowRun);
  const ids = runs.map(run => run.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate result row");
  if (requested && (ids.length !== requested.length || ids.some(id => !requested.includes(id)))) throw new Error("result does not contain the exact requested rows");
  const execPath = executable(value.execPath);
  const paths = [execPath].concat(runs.flatMap(run => run.report ? [run.report.execPath] : []));
  if (permittedExecPaths && paths.some(path => !permittedExecPaths.includes(path))) throw new Error("wrong execution route");
  return { execPath, rows: runs };
}

// ---- execution -----------------------------------------------------------------------------

interface Execution { readonly code: number | null; readonly timedOut: boolean; readonly resultText: string | null; readonly loaded: readonly LoadedObservation[]; readonly payloadEvidence?: readonly LoadedAsset[]; readonly cleanup: Record<string, unknown>; readonly error?: string | null }

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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function runGroup(command: string, args: readonly string[], cwd: string, out: string, budgetMs: number): Promise<{ code: number | null; timedOut: boolean; groupGone: boolean; error: string | null }> {
  const { stopProcessGroup } = await import("../web/tests/next-framework-process.ts");
  const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", chunk => { log += String(chunk); });
  child.stderr.on("data", chunk => { log += String(chunk); });
  const completion = Promise.withResolvers<{ code: number | null; timedOut: boolean; error: string | null }>();
  child.once("error", error => completion.resolve({ code: null, timedOut: false, error: String(error) }));
  child.once("close", code => completion.resolve({ code, timedOut: false, error: null }));
  const interrupt = () => completion.resolve({ code: null, timedOut: false, error: "Runner interrupted" });
  for (const signal of terminationSignals) process.once(signal, interrupt);
  const timer = setTimeout(() => completion.resolve({ code: null, timedOut: true, error: "Host execution deadline expired" }), budgetMs);
  let result: Awaited<typeof completion.promise>;
  try {
    result = await completion.promise;
  } finally {
    clearTimeout(timer);
    for (const signal of terminationSignals) process.removeListener(signal, interrupt);
    await stopProcessGroup(child);
    writeFileSync(join(out, "guest.log"), log);
  }
  return { ...result, groupGone: child.pid === undefined || !groupAlive(child.pid) };
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
  if (invocation.evidence.kind === "handoff") recheckFiveOwnerHandoff(invocation.evidence);
  const run = await runGroup(command, args, work, invocation.out, (invocation.rows.length + 2) * ROW_BUDGET_MS);
  const resultPath = join(work, RESULT_FILE);
  const resultText = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : null;
  return { code: run.code, timedOut: run.timedOut, resultText, loaded: [], cleanup: { processGroupGone: run.groupGone }, error: run.error };
}

function shortTmp(): string {
  const scratch = realpathSync(process.env.BUN_WASM_TEST_TMP ?? tmpdir());
  if (scratch.length > CHROMIUM_TMP_LIMIT) throw new Error(`Chromium scratch ${scratch} exceeds ${CHROMIUM_TMP_LIMIT} bytes; set TMPDIR or BUN_WASM_TEST_TMP to a short owned directory`);
  return scratch;
}

class HostDeadlineError extends Error {}

export async function hostDeadline<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Host execution interrupted"));
  const timer = setTimeout(() => controller.abort(new HostDeadlineError("Host execution deadline expired")), milliseconds);
  for (const signal of terminationSignals) process.once(signal, interrupted);
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try {
    outcome = { ok: true, value: await abortable(operation(controller.signal), controller.signal) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  controller.abort(new Error("Execution finished"));
  clearTimeout(timer);
  for (const signal of terminationSignals) process.removeListener(signal, interrupted);
  // Cleanup always runs; its error never replaces the first execution error.
  try { await cleanup(); }
  catch (error) {
    if (outcome.ok) throw error;
    throw new AggregateError([outcome.error, error], `${String(outcome.error)}; cleanup failed: ${String(error)}`, { cause: outcome.error });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

interface ChromiumResources {
  server: ChildProcess | null;
  browserServer: Promise<BrowserServer> | null;
  browser: Promise<Browser> | null;
  serverGone: boolean;
  browserGone: boolean;
}

async function stopChromium(resources: ChromiumResources): Promise<void> {
  const { stopProcessGroup } = await import("../web/tests/next-framework-process.ts");
  const browserServer = await resources.browserServer?.catch(() => null);
  const serverStop = resources.server ? stopProcessGroup(resources.server) : Promise.resolve();
  const stopped = await Promise.allSettled([serverStop, browserServer?.kill()]);
  resources.serverGone = resources.server === null || resources.server.pid === undefined || !groupAlive(resources.server.pid);
  const child = browserServer?.process();
  resources.browserGone = !child || ((child.exitCode !== null || child.signalCode !== null) && (child.pid === undefined || !groupAlive(child.pid)));
  const browser = await resources.browser?.catch(() => null);
  await browser?.close();
  await browserServer?.close();
  const failure = stopped.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  if (!resources.serverGone || !resources.browserGone) throw new Error("Chromium execution left an owned process group");
}

function startWeb(resources: ChromiumResources, webRoot: string): Promise<string> {
  const child = spawn(process.execPath, [join(root, "web/serve.ts")], { cwd: join(root, "web"), detached: true,
    env: { ...process.env, HOST: "127.0.0.1", ISOLATE: "1", PREVIEW_ORIGINS: "0", PORT: "0", ROOT: webRoot }, stdio: ["ignore", "pipe", "pipe"] });
  resources.server = child;
  const completion = Promise.withResolvers<string>();
  let output = "";
  child.stdout.on("data", chunk => {
    output += String(chunk);
    const match = /at (http:\/\/\S+) \(cross-origin isolated\)/.exec(output);
    if (match?.[1]) completion.resolve(match[1]);
  });
  child.stderr.on("data", chunk => { output += String(chunk); });
  child.once("error", completion.reject);
  child.once("exit", code => completion.reject(new Error(`Owned Web server exited ${code}: ${output}`)));
  return completion.promise;
}

async function chromiumBody(webRoot: string, invocation: Invocation, work: string, resources: ChromiumResources, signal: AbortSignal, progress: ChromiumProgress): Promise<void> {
  const { playwright, ready, run, writeFile } = await abortable(import("../web/tests/playground.mjs"), signal);
  signal.throwIfAborted();
  if (invocation.evidence.kind === "handoff") {
    recheckFiveOwnerHandoff(invocation.evidence);
    recheckFiveOwnerBrowser(invocation.evidence, playwright.chromium.executablePath());
  }
  resources.browserServer = playwright.chromium.launchServer({ timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const browserServer = await abortable(resources.browserServer, signal);
  signal.throwIfAborted();
  resources.browser = playwright.chromium.connect(browserServer.wsEndpoint(), { timeout: 30_000 });
  const browser = await abortable(resources.browser, signal);
  const url = await abortable(startWeb(resources, webRoot), signal);
  const context = await abortable(browser.newContext(), signal);
  const pinned = invocation.evidence.kind === "handoff" ? invocation.evidence : null;
  const expected = expectedBrowserPayload(webRoot, path => pinned ? readFiveOwnerMember(pinned, path) : readFileSync(path));
  const observer = loadedObserver(new URL("bun-browser.wasm", url).href, expected,
    path => { if (pinned) requireFiveOwnerResponse(pinned, path); });
  progress.observer = observer;
  context.on("response", observer.capture);
  const page = await abortable(context.newPage(), signal);
  await abortable(page.goto(`${url}?engine=browser&prompt=off`), signal);
  const status = await abortable(ready(page), signal);
  if (!/ready · Browser \(native\)/.test(status)) throw new Error(`page did not select the Browser engine: ${status}`);
  for (const name of readdirSync(work)) await abortable(writeFile(page, `/home/user/io-resource-context/${name}`, readFileSync(join(work, name), "utf8")), signal);
  const command = ["bun run io-resource-context/index.ts"].concat(invocation.rows).join(" ");
  const result = await abortable(run(page, command, (invocation.rows.length + 2) * ROW_BUDGET_MS), signal);
  progress.code = result.code;
  progress.timedOut = result.code === null;
  writeFileSync(join(invocation.out, "guest.log"), result.output);
  const read = `(async () => new TextDecoder().decode(await playground.fs.readFile(${JSON.stringify(`/home/user/io-resource-context/${RESULT_FILE}`)})))()`;
  const resultText = await abortable(page.evaluate(read), signal);
  if (typeof resultText !== "string") throw new Error("Missing Chromium guest result");
  progress.resultText = resultText;
  await abortable(observer.flush(), signal);
  await abortable(context.close(), signal);
  await abortable(observer.finish(), signal);
}

interface ChromiumProgress {
  code: number | null;
  timedOut: boolean;
  resultText: string | null;
  observer: ReturnType<typeof loadedObserver> | null;
}

function deadlineFailure(error: unknown): boolean {
  if (error instanceof HostDeadlineError) return true;
  return error instanceof AggregateError && error.errors.some(deadlineFailure);
}

export async function captureChromiumExecution(options: {
  readonly budgetMs: number;
  readonly operation: (signal: AbortSignal, progress: ChromiumProgress) => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly cleanupStatus: () => Execution["cleanup"];
}): Promise<Execution> {
  const progress: ChromiumProgress = { code: null, timedOut: false, resultText: null, observer: null };
  let error: string | null = null;
  try {
    await hostDeadline(options.budgetMs, signal => options.operation(signal, progress), options.cleanup);
  } catch (caught) {
    error = String(caught);
    progress.timedOut ||= deadlineFailure(caught);
  }
  const observations = progress.observer?.snapshot();
  return { code: progress.code, timedOut: progress.timedOut, resultText: progress.resultText,
    loaded: observations?.loaded ?? [], payloadEvidence: observations?.payloads ?? [], cleanup: options.cleanupStatus(), error };
}

async function runChromium(webRoot: string, invocation: Invocation, work: string): Promise<Execution> {
  shortTmp();
  const resources: ChromiumResources = { server: null, browserServer: null, browser: null, serverGone: false, browserGone: false };
  return await captureChromiumExecution({
    budgetMs: (invocation.rows.length + 2) * ROW_BUDGET_MS,
    operation: (signal, progress) => chromiumBody(webRoot, invocation, work, resources, signal, progress),
    cleanup: () => stopChromium(resources),
    cleanupStatus: () => ({ browserClosed: resources.browserGone, serverGroupGone: resources.serverGone }),
  });
}

// ---- admission -----------------------------------------------------------------------------

async function admitNative(surface: Extract<Surface, { kind: "native" }>, evidence: Evidence): Promise<{ artifacts: FileIdentity[]; receipts: unknown[] }> {
  const artifacts = [identity("guest", surface.guest), identity("launcher", surface.launcher), identity("shell", surface.shell), identity("env-utility", surface.envUtility)];
  if (evidence.kind !== "handoff") return { artifacts, receipts: [] };
  const receipt = await verifyFiveOwnerGuest(evidence, surface.engine);
  const receiptPath = `${surface.guest}.build.json`;
  const launcherReceiptPath = `${surface.launcher}.launcher.json`;
  verifyLauncher(surface.launcher, JSON.parse(readFiveOwnerMember(evidence, launcherReceiptPath).toString("utf8")), evidence.handoff.source);
  requireFiveOwnerMember(evidence, surface.launcher);
  return { artifacts: artifacts.concat(identity("guest-receipt", receiptPath), identity("launcher-receipt", launcherReceiptPath)),
    receipts: [{ guest: receiptPath, program: receipt.program, sourceManifestSha256: receipt.sourceManifestSha256 }] };
}

function admitChromium(webRoot: string): FileIdentity[] {
  const registry = join(webRoot, "engine-builds.json");
  if (!existsSync(registry)) throw new Error(`web root has no engine-builds.json: ${webRoot}`);
  return [identity("engine-builds", registry), identity("index", join(webRoot, "index.html"))];
}

// ---- main ----------------------------------------------------------------------------------

function resultStatus(surface: Surface, verdicts: readonly RowVerdict[], execution: Execution, parsed: GuestResult | null): "pass" | "partial" | "fail" {
  if (!parsed || execution.error || execution.timedOut || execution.code !== 0) return "fail";
  if (Object.values(execution.cleanup).some(value => value !== true)) return "fail";
  if (surface.kind === "chromium" && !execution.loaded.some(file => /\/bun-browser\.wasm(?:\.gz)?$/.test(new URL(file.url).pathname))) return "fail";
  if (verdicts.some(verdict => verdict.status !== "pass" && verdict.status !== "limited")) return "fail";
  return verdicts.some(verdict => verdict.status === "limited") ? "partial" : "pass";
}

function permittedRoutes(surface: Surface): readonly string[] {
  if (surface.kind === "host-bun") return [process.execPath];
  const engine = surface.kind === "native" ? surface.engine : "browser";
  return ["/bin/bun", `/opt/bun/${engine}/bin/bun`];
}

async function execute(invocation: Invocation, work: string): Promise<Execution> {
  const { surface } = invocation;
  if (surface.kind === "chromium") return await runChromium(surface.webRoot, invocation, work);
  return await runHost(surface, invocation, work);
}

interface ResultInput {
  readonly invocation: Invocation;
  readonly admitted: { readonly artifacts: readonly FileIdentity[]; readonly receipts: readonly unknown[] };
  readonly fixtureFiles: readonly FileIdentity[];
  readonly execution: Execution;
  readonly parsed: GuestResult | null;
  readonly error: string | null;
  readonly workRemoved: boolean;
}

/** Exact output contract. Exit zero permits partial observations; it never promotes them to qualification. */
export function buildFiveOwnerResult({ invocation, admitted, fixtureFiles, execution, parsed, error, workRemoved }: ResultInput) {
  const { surface, evidence } = invocation;
  const verdicts = parsed ? evaluate(parsed, invocation.rows, contextClass(surface)) : invocation.rows.map(id => evaluateRow(id, undefined, contextClass(surface)));
  const status = error || !workRemoved ? "fail" : resultStatus(surface, verdicts, execution, parsed);
  const omitted = rowIds.filter(id => !invocation.rows.includes(id));
  const projectedEvidence = evidence.kind === "handoff"
    ? { kind: evidence.kind, reference: evidence.reference, source: evidence.handoff.source, tuple: evidence.handoff.tuple, intake: evidence.handoff.intake,
      replay: evidence.replay.replay, harness: evidence.replay.harness }
    : evidence;
  const admissionKind: "verified-c1-intake" | "source-check-only" = evidence.kind === "handoff" ? "verified-c1-intake" : "source-check-only";
  return {
    schema: RESULT_SCHEMA, status, error: execution.error ?? error ?? null,
    diagnostics: error && execution.error && error !== execution.error ? [error] : [], surface, contextClass: contextClass(surface),
    evidence: projectedEvidence,
    qualification: evidence.kind === "handoff" && status === "pass" && omitted.length === 0,
    acceptanceScope: "Observed public-API rows only; named unqualified lifetime/fault limits remain",
    admission: { kind: admissionKind },
    coverage: { requested: invocation.rows, omittedImplemented: omitted, limitedNativeRows: verdicts.filter(verdict => verdict.status === "limited").map(verdict => verdict.id) },
    artifacts: admitted.artifacts, receipts: admitted.receipts, loaded: execution.loaded, payloadEvidence: execution.payloadEvidence ?? [], fixture: fixtureFiles,
    guest: { exitCode: execution.code, timedOut: execution.timedOut, execPath: parsed?.execPath ?? null, rowExecPaths: parsed?.rows.map(run => run.report?.execPath ?? null) ?? [] },
    rows: verdicts, unqualified,
    cleanup: { ...execution.cleanup, workRemoved },
  };
}
export type FiveOwnerResult = ReturnType<typeof buildFiveOwnerResult>;

export function inspectExecution(invocation: Invocation, execution: Execution): { parsed: GuestResult | null; error: string | null } {
  let parsed: GuestResult | null = null;
  try {
    if (execution.resultText !== null) parsed = parseGuestResult(execution.resultText, invocation.rows, permittedRoutes(invocation.surface));
    if (!execution.error && invocation.evidence.kind === "handoff" && invocation.surface.kind === "chromium") {
      bindLoaded(invocation.evidence.handoff, "web", execution.loaded);
    }
  } catch (error) {
    return { parsed, error: String(error) };
  }
  return { parsed, error: execution.error ?? null };
}

function finishRun(work: string, evidence: Evidence): void {
  rmSync(work, { recursive: true, force: true });
  if (evidence.kind === "handoff") recheckFiveOwnerHandoff(evidence);
}

export async function main(argv: readonly string[]): Promise<number> {
  const invocation = parseInvocation(argv);
  mkdirSync(invocation.out, { recursive: true });
  const work = join(invocation.out, "work");
  if (existsSync(work) || existsSync(join(invocation.out, "result.json"))) throw new Error("Output is not fresh");
  const { surface, evidence } = invocation;
  let admitted: { artifacts: FileIdentity[]; receipts: unknown[] } = { artifacts: [], receipts: [] };
  let fixtureFiles: FileIdentity[] = [];
  let execution: Execution = { code: null, timedOut: false, resultText: null, loaded: [], cleanup: { executionCleanupConfirmed: false } };
  let parsed: GuestResult | null = null;
  let error: string | null = null;
  try {
    admitted = surface.kind === "native" ? await admitNative(surface, evidence) : { artifacts: surface.kind === "chromium" ? admitChromium(surface.webRoot) : [], receipts: [] };
    if (evidence.kind === "handoff" && surface.kind === "chromium") await verifyFiveOwnerGuest(evidence, "browser");
    fixtureFiles = stageFixture(work);
    execution = await execute(invocation, work);
    const inspected = inspectExecution(invocation, execution);
    parsed = inspected.parsed;
    error = inspected.error;
  } catch (caught) {
    error = String(caught);
  } finally {
    try { finishRun(work, evidence); }
    catch (caught) { error = `${error ?? ""} Cleanup or input custody failed: ${String(caught)}`; }
  }
  const result = buildFiveOwnerResult({ invocation, admitted, fixtureFiles, execution, parsed, error, workRemoved: !existsSync(work) });
  writeFileSync(join(invocation.out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  for (const verdict of result.rows) console.log(`${verdict.status.toUpperCase()} ${verdict.id}${verdict.reasons.length ? ` ${verdict.reasons[0]}` : ""}`);
  console.log(`${result.status.toUpperCase()} io-resource-context ${surface.kind}: ${result.rows.filter(verdict => verdict.status === "pass").length}/${result.rows.length} exact rows`);
  return result.status === "fail" ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
