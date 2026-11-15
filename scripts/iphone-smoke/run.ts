import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { frameworks, type Box } from "../goals-matrix/catalog";
import { executeAttempt, type Execution } from "../goals-matrix/execute";
import { initialReport, playgroundURL } from "../goals-matrix/run";
import { preflight } from "../goals-matrix/preparation";
import { verifyPreparedSiteInventory } from "../goals-matrix/prepared-site";
import { createIphoneTransport } from "../goals-matrix/iphone-transport";
import { withSignals } from "../goals-matrix/lifetime";
import { object } from "../goals-matrix/evidence";
import { engineFiles } from "../goals-matrix/engines";
import { verifyMacAdmission } from "./admission";
import { deviceUDID, phaseTimeoutMs, installTimeoutMs, type SmokeOptions } from "./options";
import { completedCase, pendingCase, smokeCases, unsafeToContinue, type SmokeCase, type SmokeReport } from "./model";

interface SmokeIO {
  qualify(config: SmokeOptions): Promise<NonNullable<SmokeReport["source"]>>;
  admission: typeof verifyMacAdmission;
  transport(config: SmokeOptions, box: Box): ReturnType<Execution["createTransport"]>;
  verify(root: string): Promise<void>;
}
async function readSource(config: SmokeOptions): Promise<NonNullable<SmokeReport["source"]>> {
  const source = object(JSON.parse(await readFile(config.sourceFile, "utf8")));
  if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit) || typeof source.dirty !== "boolean" || source.assets === undefined) throw new Error("--source-file requires goals-matrix source metadata with commit, dirty and assets");
  return { commit: source.commit, dirty: source.dirty, assets: source.assets };
}
async function qualify(config: SmokeOptions): Promise<NonNullable<SmokeReport["source"]>> {
  for (const name of ["index.html", "goals-host-source.json", "goals-asset-sources.json", "goals-site-inventory.json"]) {
    if (!await Bun.file(join(config.matrix.root, name)).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
  }
  for (const name of engineFiles("browser").concat(engineFiles("quickjs"))) {
    if (!await Bun.file(join(config.matrix.root, name)).exists() && !await Bun.file(join(config.matrix.root, name + ".gz")).exists()) throw new Error(`Prepared smoke root is missing ${name}`);
  }
  await verifyPreparedSiteInventory(config.matrix.root);
  await preflight(config.matrix.root, ["browser", "quickjs"]);
  return (await initialReport(config.matrix)).source;
}
const defaultIO: SmokeIO = {
  qualify,
  admission: verifyMacAdmission,
  verify: verifyPreparedSiteInventory,
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
    report.source = await io.qualify(config);
    report.revision = report.source.commit;
    report.cases = smokeCases.map(box => pendingCase(box, report.source));
    const ticket = await io.admission(config.thread, undefined, signal);
    await cases(config, report, io, ticket, signal);
    await io.verify(config.matrix.root);
  } catch (error) {
    report.failures.push({ phase: "prerequisite", error: String(error) });
    report.cases = report.cases.map(result => result.status === "pending" ? blocked(result, String(error)) : result);
  } finally {
    report.finishedAt = new Date().toISOString();
    await save(report);
  }
  return report;
}
async function cases(config: SmokeOptions, report: SmokeReport, io: SmokeIO, ticket: string, signal?: AbortSignal): Promise<void> {
  let stopped: string | undefined;
  for (const [index, box] of smokeCases.entries()) {
    const pending = pendingCase(box, report.source);
    if (signal?.aborted) stopped = String(signal.reason);
    const result = stopped ? blocked(pending, stopped) : await runCase(config, box, report.source, io, ticket, signal);
    report.cases[index] = result;
    stopped ??= unsafeToContinue(result);
    if (result.status === "blocked") stopped ??= result.failures[0]?.error;
    await save(report);
  }
}
function blocked(result: SmokeCase, error: string): SmokeCase {
  return { ...result, status: "blocked", failures: [{ phase: "prerequisite", error }] };
}
async function runCase(config: SmokeOptions, box: Box, source: SmokeCase["source"], io: SmokeIO, ticket: string, signal?: AbortSignal): Promise<SmokeCase> {
  try { await io.admission(config.thread, ticket, signal); }
  catch (error) { return blocked(pendingCase(box, source), String(error)); }
  const framework = frameworks.find(item => item.id === box.framework);
  if (!framework) throw new Error(`Missing maintained framework ${box.framework}`);
  const attempt = await executeAttempt({ box, framework, url: playgroundURL("http://127.0.0.1/", framework, box.engine),
    timeoutMs: phaseTimeoutMs, installTimeoutMs, signal,
    createTransport: () => io.transport(config, box),
    saveLog: text => Bun.write(join(config.matrix.output, "logs", `${box.framework}-${box.engine}.log`), text).then(() => {}),
  }, "click");
  return completedCase(box, source, attempt);
}
export async function smoke(config: SmokeOptions): Promise<SmokeReport> {
  return withSignals(signal => runSmoke(config, {}, signal));
}
