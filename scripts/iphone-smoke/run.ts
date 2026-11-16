import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { frameworks, type Box, type Framework } from "../goals-matrix/catalog";
import { executeAttempt, type Execution } from "../goals-matrix/execute";
import { playgroundURL } from "../goals-matrix/run";
import { preflight } from "../goals-matrix/preparation";
import { createIphoneTransport } from "../goals-matrix/iphone-transport";
import { withSignals } from "../goals-matrix/lifetime";
import { object } from "../goals-matrix/evidence";
import { profileEngineFiles } from "../goals-matrix/engines";
import { templateProfile, type PlaygroundProfile } from "../../web/src/playground/program-profile";
import { verifyMacAdmission } from "./admission";
import { deviceUDID, phaseTimeoutMs, installTimeoutMs, type SmokeOptions } from "./options";
import { completedCase, pendingCase, unsafeToContinue, type SmokeCase, type SmokeReport } from "./model";
import { smokeCases } from "./cases";

type Selection = { box: Box; framework: Framework; profile: PlaygroundProfile };
interface SmokeIO {
  qualify(config: SmokeOptions, programs: readonly Selection[]): Promise<void>;
  admission: typeof verifyMacAdmission;
  transport(config: SmokeOptions, box: Box): ReturnType<Execution["createTransport"]>;
  verify(root: string, programs: readonly Selection[]): Promise<void>;
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
async function readSource(config: SmokeOptions): Promise<NonNullable<SmokeReport["source"]>> {
  const source = object(JSON.parse(await readFile(config.sourceFile, "utf8")));
  if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit) || (source.dirty !== undefined && typeof source.dirty !== "boolean")) throw new Error("--source-file requires a recorded 40-character commit and optional boolean dirty flag");
  return { commit: source.commit, dirty: source.dirty ?? null, assets: source.assets ?? { source: config.matrix.assetSource } };
}
async function qualify(config: SmokeOptions, programs: readonly Selection[]): Promise<void> {
  for (const name of ["index.html", "engine-builds.json"]) {
    if (!await Bun.file(join(config.matrix.root, name)).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
  }
  for (const { box, profile } of programs) {
    for (const name of profileEngineFiles(box.engine, profile)) {
      if (!await Bun.file(join(config.matrix.root, name)).exists() && !await Bun.file(join(config.matrix.root, name + ".gz")).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
    }
  }
  await verifyPrograms(config.matrix.root, programs);
}
const defaultIO: SmokeIO = {
  qualify,
  admission: verifyMacAdmission,
  verify: verifyPrograms,
  transport: async (config, box) => createIphoneTransport({ control: config.control, agent: config.agent, deviceUDID,
    timeoutMs: phaseTimeoutMs, cleanupTimeoutMs: 20_000,
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
    resources: { owned: ["case Safari tabs and guest foreground processes"], external: ["prepared root", "Mac FIFO wrapper and observer server", "control port forward", "T3 device session and retained simulator"] } };
  await save(report);
  try {
    report.source = await readSource(config);
    report.revision = report.source.commit;
    report.cases = smokeCases.map(box => pendingCase(box, report.source));
    const selections = smokeCases.map(select);
    const programs = uniquePrograms(selections);
    await io.qualify(config, programs);
    const ticket = await io.admission(config.thread, undefined, signal);
    await cases(config, report, io, ticket, selections, signal);
    signal?.throwIfAborted();
    await io.verify(config.matrix.root, programs);
    signal?.throwIfAborted();
  } catch (error) {
    report.failures.push({ phase: signal?.aborted ? "interruption" : "prerequisite", error: String(error) });
    report.cases = report.cases.map(result => result.status === "pending" ? blocked(result, String(error)) : result);
  } finally {
    report.finishedAt = new Date().toISOString();
    await save(report);
  }
  return report;
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
function blocked(result: SmokeCase, error: string): SmokeCase {
  return { ...result, status: "blocked", failures: [{ phase: "prerequisite", error }] };
}
async function runCase(config: SmokeOptions, selection: Selection, source: SmokeCase["source"], io: SmokeIO, ticket: string, signal?: AbortSignal): Promise<SmokeCase> {
  const { box, framework, profile } = selection;
  try { await io.admission(config.thread, ticket, signal); }
  catch (error) { return blocked(pendingCase(box, source), String(error)); }
  const attempt = await executeAttempt({ box, framework, profile, url: playgroundURL("http://127.0.0.1/", framework, box.engine, profile),
    timeoutMs: phaseTimeoutMs, installTimeoutMs, signal,
    createTransport: () => io.transport(config, box),
    saveLog: text => Bun.write(join(config.matrix.output, "logs", `${box.framework}-${box.engine}.log`), text).then(() => {}),
  }, "click");
  return completedCase(box, source, attempt);
}
export async function smoke(config: SmokeOptions): Promise<SmokeReport> {
  return withSignals(signal => runSmoke(config, {}, signal));
}
