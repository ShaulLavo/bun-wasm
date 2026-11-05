import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { enableSubreaper } from "./linux-subreaper.mts";
import { sha256Text } from "./c1/contract.ts";
import { loadRun } from "./c1/inputs.ts";
import { check, operationSucceeded, produce, rehearse, replay } from "./c1/operations.ts";

const usage = `Usage:
  bun scripts/c1-controller.ts check CONFIG
  bun scripts/c1-controller.ts rehearse CONFIG --from RETAINED_ARTIFACT_ROOT [--stage NAME]
  bun scripts/c1-controller.ts run CONFIG --execute CONFIG_SHA256
  bun scripts/c1-controller.ts replay REPLAY.json --execute REPLAY_SHA256`;

async function main(signal: AbortSignal): Promise<boolean> {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    execute: { type: "string" }, from: { type: "string" }, stage: { type: "string" },
  } });
  const [operation, path, ...extra] = positionals;
  if (!path || extra.length) throw new Error(usage);
  // The replay contract names the product config itself; it is never a CONFIG argument.
  const pinned = operation === "replay" ? { replaySha256: sha256Text(values.execute, "--execute") } : { configSha256: loadRun(resolve(path)).configSha256 };
  const outcome = await select(operation, resolve(path), values, signal);
  process.stdout.write(JSON.stringify({ operation, ...pinned, ...outcome, error: outcome.error instanceof Error ? outcome.error.message : outcome.error }, null, 2) + "\n");
  return operationSucceeded(outcome);
}
type Values = { execute?: string; from?: string; stage?: string };
function select(operation: string | undefined, path: string, values: Values, signal: AbortSignal) {
  if (operation === "replay") return replay(path, sha256Text(values.execute, "--execute"), signal);
  const run = loadRun(path);
  if (operation === "check") return check(run, signal);
  if (operation === "run") return produce(run, sha256Text(values.execute, "--execute"), signal);
  if (operation === "rehearse") {
    if (!values.from) throw new Error(usage);
    return rehearse(run, resolve(values.from), values.stage, signal);
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
