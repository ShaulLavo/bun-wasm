import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { enableSubreaper } from "../linux-subreaper.mts";
import { ProcessOwner } from "../process-owner.mts";
import type { StageContext } from "./stages.ts";

/** A stage context as the controller hands it to a step child: everything but the live process owner. */
export type SerializedStageContext = Omit<StageContext, "owner" | "records"> & { readonly records: Readonly<Record<keyof StageContext["records"], string>> };
type Step = (context: StageContext, signal: AbortSignal) => Promise<void> | void;

export function serializeContext(context: StageContext): SerializedStageContext {
  const { owner: _owner, records, ...rest } = context;
  return { ...rest, records: { config: Buffer.from(records.config).toString("base64"), inputs: Buffer.from(records.inputs).toString("base64"), environment: Buffer.from(records.environment).toString("base64") } };
}
function deserializeContext(value: SerializedStageContext, owner: ProcessOwner): StageContext {
  const records = { config: Buffer.from(value.records.config, "base64"), inputs: Buffer.from(value.records.inputs, "base64"), environment: Buffer.from(value.records.environment, "base64") };
  return { ...value, records, owner };
}

/**
 * Child-side runner: one named step from one module, in its own process, so
 * the controller can drain it (and anything it starts) on abort, whether or
 * not the step itself ever looks at its signal.
 *
 *   bun scripts/c1/step.ts /abs/module.ts STEP_NAME /abs/context.json
 */
if (import.meta.main) {
  const [module, name, contextPath, ...extra] = process.argv.slice(2);
  if (!module || !isAbsolute(module) || !name || !contextPath || extra.length) throw new Error("Usage: bun scripts/c1/step.ts /abs/module.ts STEP_NAME /abs/context.json");
  await enableSubreaper();
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("C1 step interrupted"));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const loaded: { steps?: Readonly<Record<string, Step>> } = await import(pathToFileURL(module).href);
  const step = loaded.steps?.[name];
  if (typeof step !== "function") throw new Error(`${module} has no step ${name}`);
  const context = deserializeContext(JSON.parse(readFileSync(contextPath, "utf8")) as SerializedStageContext, new ProcessOwner());
  await step(context, abort.signal);
}
