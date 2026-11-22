import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { frameworks, type Box, type Framework } from "../goals-matrix/catalog";
import { executeAttempt, type Execution } from "../goals-matrix/execute";
import { cleanupTimeoutMs } from "../goals-matrix/deadlines";
import { playgroundURL } from "../goals-matrix/run";
import { preflight } from "../goals-matrix/preparation";
import { createIphoneTransport } from "../goals-matrix/iphone-transport";
import { withSignals } from "../goals-matrix/lifetime";
import { object } from "../goals-matrix/evidence";
import { profileEngineFiles } from "../goals-matrix/engines";
import { templateProfile, type PlaygroundProfile } from "../../web/src/playground/program-profile";
import { verifyMacAdmission } from "./admission";
import { safariTabJournal } from "./tab-journal";
import { deviceUDID, phaseTimeoutMs, installTimeoutMs, type SmokeOptions } from "./options";
import { StepFailure, completedCase, pendingCase, unsafeToContinue, type SmokeCase, type SmokeReport } from "./model";
import { smokeCases } from "./cases";
import { compareLiveOrigin, liveFetch, liveSource, withLiveRoot, type LiveFetch } from "./live";
import { livePlaygroundPath } from "../goals-matrix/iphone-live-proxy";

type Selection = { box: Box; framework: Framework; profile: PlaygroundProfile };
type Source = NonNullable<SmokeReport["source"]>;
interface SmokeIO {
  /** Reads the live site; local mode never calls it. */
  fetch: LiveFetch;
  qualify(config: SmokeOptions, programs: readonly Selection[], get: LiveFetch): Promise<void>;
  admission: typeof verifyMacAdmission;
  transport(config: SmokeOptions, box: Box, beforeNative: (signal: AbortSignal) => Promise<unknown>): ReturnType<Execution["createTransport"]>;
  verify(config: SmokeOptions, programs: readonly Selection[], source: Source, get: LiveFetch): Promise<void>;
  /** Live mode: what the Mac proxy received from the live origin during the run. */
  served(config: SmokeOptions): Promise<unknown>;
}
function select(box: Box): Selection {
  const framework = frameworks.find(item => item.id === box.framework);
  if (!framework) throw new Error(`Missing maintained framework ${box.framework}`);
  return { box, framework, profile: templateProfile(box.engine, framework.template) };
}
function uniquePrograms(selections: readonly Selection[]): Selection[] {
  const seen = new Set<string>();
  return selections.filter(({ box, profile }) => {
    const key = `${box.engine}/${profile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function verifyPrograms(root: string, programs: readonly Selection[]): Promise<void> {
  for (const { box, profile } of programs) await preflight(root, [box.engine], profile);
}
async function readSource(config: SmokeOptions, get: LiveFetch): Promise<Source> {
  if (config.target.mode === "live") return liveSource(config.target.url, get);
  const source = object(JSON.parse(await readFile(config.target.sourceFile, "utf8")));
  if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit) || (source.dirty !== undefined && typeof source.dirty !== "boolean")) throw new Error("--source-file requires a recorded 40-character commit and optional boolean dirty flag");
  return { commit: source.commit, dirty: source.dirty ?? null, assets: source.assets ?? { source: config.matrix.assetSource } };
}
const programFiles = (programs: readonly Selection[]): string[] => programs.flatMap(({ box, profile }) => profileEngineFiles(box.engine, profile));
async function qualifyRoot(root: string, programs: readonly Selection[]): Promise<void> {
  for (const name of ["index.html", "engine-builds.json"]) {
    if (!await Bun.file(join(root, name)).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
  }
  for (const name of programFiles(programs)) {
    if (!await Bun.file(join(root, name)).exists() && !await Bun.file(join(root, name + ".gz")).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
  }
  await verifyPrograms(root, programs);
}
/** Live mode runs the same fingerprint preflight on the deployed host page, manifest and engine bytes. */
async function qualify(config: SmokeOptions, programs: readonly Selection[], get: LiveFetch): Promise<void> {
  const { target } = config;
  if (target.mode === "local") return qualifyRoot(target.root, programs);
  await withLiveRoot(target.url, programFiles(programs), get, root => qualifyRoot(root, programs));
}
async function verify(config: SmokeOptions, programs: readonly Selection[], source: Source, get: LiveFetch): Promise<void> {
  const { target } = config;
  if (target.mode === "local") return verifyPrograms(target.root, programs);
  await withLiveRoot(target.url, programFiles(programs), get, root => verifyPrograms(root, programs));
  const current = await liveSource(target.url, get);
  if (current.commit !== source.commit) throw new Error(`Live site changed deployment during smoke: ${source.commit} became ${current.commit}`);
}
/** The playground page the observer serves: a local root is the playground; a deployed site holds it under /playground/. */
function pageBase(config: SmokeOptions): string {
  return config.target.mode === "live" ? "http://127.0.0.1/" + livePlaygroundPath : "http://127.0.0.1/";
}
const defaultIO: SmokeIO = {
  fetch: liveFetch,
  qualify,
  admission: verifyMacAdmission,
  verify,
  served: async config => {
    const response = await fetch(config.control + "/live/served", { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new StepFailure("live-origin", `Live origin check: the observer answered ${response.status} for its served responses`);
    return response.json();
  },
  transport: async (config, box, beforeNative) => createIphoneTransport({ control: config.control, agent: config.agent, deviceUDID,
    timeoutMs: phaseTimeoutMs, cleanupTimeoutMs, beforeNative, tabJournal: safariTabJournal(),
    saveNative: text => appendFile(join(config.matrix.output, "logs", `${box.framework}-${box.engine}.native.jsonl`), text) }),
};
async function save(report: SmokeReport): Promise<void> {
  report.status = report.failures.length === 0 && report.cases.every(result => result.status === "pass") ? "green" : "red";
  report.failedPhase = report.cases.flatMap(result => result.failures)[0]?.phase ?? report.failures[0]?.phase ?? null;
  const temporary = report.reportPath + ".tmp";
  await Bun.write(temporary, JSON.stringify(report, null, 2) + "\n");
  await rename(temporary, report.reportPath);
}
export async function runSmoke(config: SmokeOptions, overrides: Partial<SmokeIO> = {}, signal?: AbortSignal): Promise<SmokeReport> {
  const io = { ...defaultIO, ...overrides };
  await mkdir(config.matrix.output);
  await mkdir(join(config.matrix.output, "logs"));
  const report: SmokeReport = { schema: 1, kind: "manual-iphone-smoke", revision: null, source: null, status: "red", failedPhase: null,
    reportPath: join(config.matrix.output, "result.json"), createdAt: new Date().toISOString(), finishedAt: null,
    cases: smokeCases.map(box => pendingCase(box, null)), failures: [],
    resources: { owned: ["case Safari tabs and guest foreground processes"], external: [config.target.mode === "live" ? `deployed site ${config.target.url}` : "prepared root", "Mac FIFO wrapper and observer server", "control port forward", "T3 device session and retained simulator"] } };
  await save(report);
  try {
    const source = report.source = await readSource(config, io.fetch);
    report.revision = source.commit;
    report.cases = smokeCases.map(box => pendingCase(box, source));
    const selections = smokeCases.map(select);
    const programs = uniquePrograms(selections);
    if (config.target.mode === "live") requireLiveCases(selections);
    await io.qualify(config, programs, io.fetch);
    const ticket = await io.admission(config.thread, undefined, signal).catch(error => {
      throw new StepFailure("mac-admission", error instanceof Error ? error.message : String(error));
    });
    await cases(config, report, io, ticket, selections, signal);
    signal?.throwIfAborted();
    await io.verify(config, programs, source, io.fetch);
    signal?.throwIfAborted();
    if (config.target.mode === "live") await checkLiveOrigin(config, config.target.url, report, io);
  } catch (error) {
    const phase = signal?.aborted ? "interruption" : error instanceof StepFailure ? error.phase : "prerequisite";
    report.failures.push({ phase, error: String(error) });
    report.cases = report.cases.map(result => result.status === "pending" ? blocked(result, String(error), phase === "interruption" ? "prerequisite" : phase) : result);
  } finally {
    report.finishedAt = new Date().toISOString();
    await save(report);
  }
  return report;
}
/** Root previews need the local server's preview-origin host, which the live proxy does not have. */
function requireLiveCases(selections: readonly Selection[]): void {
  const rooted = selections.filter(({ framework }) => framework.rootPreview).map(({ box }) => box.framework);
  if (rooted.length) throw new Error(`Live mode cannot serve root previews: ${rooted.join(", ")}`);
}
/** Repeats the run's live requests against the real origin; any difference makes the smoke red. */
async function checkLiveOrigin(config: SmokeOptions, site: string, report: SmokeReport, io: SmokeIO): Promise<void> {
  const check = report.liveOrigin = await compareLiveOrigin(site, await io.served(config), io.fetch);
  if (check.mismatches.length) throw new StepFailure("live-origin", `Live origin check: ${check.mismatches.length} difference(s) from the real origin: ${check.mismatches.slice(0, 5).join("; ")}`);
}
async function cases(config: SmokeOptions, report: SmokeReport, io: SmokeIO, ticket: string, selections: readonly Selection[], signal?: AbortSignal): Promise<void> {
  let stopped: string | undefined;
  for (const [index, selection] of selections.entries()) {
    const { box } = selection;
    const pending = pendingCase(box, report.source);
    if (signal?.aborted) stopped = String(signal.reason);
    const result = stopped ? blocked(pending, stopped) : await runCase(config, selection, report.source, io, ticket, signal);
    report.cases[index] = result;
    stopped ??= unsafeToContinue(result);
    if (result.status === "blocked") stopped ??= result.failures[0]?.error;
    await save(report);
  }
}
function blocked(result: SmokeCase, error: string, phase = "prerequisite"): SmokeCase {
  return { ...result, status: "blocked", failures: [{ phase, error }] };
}
async function runCase(config: SmokeOptions, selection: Selection, source: SmokeCase["source"], io: SmokeIO, ticket: string, signal?: AbortSignal): Promise<SmokeCase> {
  const { box, framework, profile } = selection;
  try { await io.admission(config.thread, ticket, signal); }
  catch (error) { return blocked(pendingCase(box, source), String(error), "mac-admission"); }
  const attempt = await executeAttempt({ box, framework, profile, url: playgroundURL(pageBase(config), framework, box.engine, profile),
    timeoutMs: phaseTimeoutMs, installTimeoutMs, signal,
    createTransport: () => io.transport(config, box, nativeSignal => io.admission(config.thread, ticket, nativeSignal)),
    saveLog: text => Bun.write(join(config.matrix.output, "logs", `${box.framework}-${box.engine}.log`), text).then(() => {}),
  }, "click");
  return completedCase(box, source, attempt);
}
export async function smoke(config: SmokeOptions): Promise<SmokeReport> {
  return withSignals(signal => runSmoke(config, {}, signal));
}
