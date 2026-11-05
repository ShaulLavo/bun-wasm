import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { enableSubreaper } from "./linux-subreaper.mts";
import { sha256Text } from "./c1/contract.ts";
import { loadRun } from "./c1/inputs.ts";
import { check, operationSucceeded, produce, qualify, rehearse } from "./c1/operations.ts";

const usage = `Usage:
  bun scripts/c1-controller.ts check CONFIG
  bun scripts/c1-controller.ts rehearse CONFIG --from RETAINED_ARTIFACT_ROOT [--stage NAME]
  bun scripts/c1-controller.ts run CONFIG --execute CONFIG_SHA256
  bun scripts/c1-controller.ts qualify CONFIG --intake INTAKE.json --intake-sha256 SHA256`;

async function main(signal: AbortSignal): Promise<boolean> {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    execute: { type: "string" }, from: { type: "string" }, stage: { type: "string" }, intake: { type: "string" }, "intake-sha256": { type: "string" },
  } });
  const [operation, configPath, ...extra] = positionals;
  if (!configPath || extra.length) throw new Error(usage);
  const run = loadRun(resolve(configPath));
  const outcome = await select(operation, run, values, signal);
  process.stdout.write(JSON.stringify({ operation, configSha256: run.configSha256, ...outcome, error: outcome.error instanceof Error ? outcome.error.message : outcome.error }, null, 2) + "\n");
  return operationSucceeded(outcome);
}
type Values = { execute?: string; from?: string; stage?: string; intake?: string; "intake-sha256"?: string };
function select(operation: string | undefined, run: ReturnType<typeof loadRun>, values: Values, signal: AbortSignal) {
  if (operation === "check") return check(run, signal);
  if (operation === "run") return produce(run, sha256Text(values.execute, "--execute"), signal);
  if (operation === "rehearse") {
    if (!values.from) throw new Error(usage);
    return rehearse(run, resolve(values.from), values.stage, signal);
  }
  if (operation === "qualify") {
    if (!values.intake) throw new Error(usage);
    return qualify(run, resolve(values.intake), sha256Text(values["intake-sha256"], "--intake-sha256"), signal);
  }
  throw new Error(usage);
}

if (import.meta.main) {
  await enableSubreaper();
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("C1 controller interrupted"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try { process.exitCode = await main(abort.signal) ? 0 : 1; }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
