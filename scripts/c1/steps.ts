import { existsSync } from "node:fs";
import { join } from "node:path";
import { sealDelivery, sealTree, treeMembers } from "./delivery.ts";
import { capture, initialize, matrixInputs, publicationMatrix, smokeInputs, stageDelivery, stageGuest, verifyDelivery } from "./publication.ts";
import type { StageContext } from "./stages.ts";

/**
 * Every in-process stage action, by name. The stage runner executes each one
 * in an owned child process (scripts/c1/step.ts), never inside the
 * controller, so cancellation drains it like any command.
 */
export const steps = {
  initialize: (context: StageContext) => initialize(context),
  captureBefore: (context: StageContext) => capture(context, "before"),
  captureAfter: (context: StageContext) => capture(context, "after"),
  capturePreseal: (context: StageContext) => capture(context, "preseal"),
  stageBrowser: (context: StageContext) => stageGuest(context, "browser"),
  stageTools: (context: StageContext) => stageGuest(context, "tools"),
  smokeDefault: (context: StageContext) => smokeInputs(context, "default"),
  smokeSourceCache: (context: StageContext) => smokeInputs(context, "source-cache"),
  smokeMatrix: (context: StageContext) => smokeInputs(context, "matrix"),
  matrixInputs: (context: StageContext) => matrixInputs(context),
  publicationMatrix: (context: StageContext, signal: AbortSignal) => publicationMatrix(context, signal),
  stageDelivery: (context: StageContext) => { stageDelivery(context); },
  verifyDelivery: (context: StageContext) => verifyDelivery(context, join(context.artifact, "delivery")),
  seal,
} as const;
export type StepName = keyof typeof steps;

/**
 * Production seals DELIVERY.json once. Rehearsal applies the same seal
 * mechanics to its private copy under a rehearsal-only inventory and never
 * writes producer status; copied historical status files are just members.
 */
function seal(context: StageContext): void {
  const delivery = join(context.artifact, "delivery");
  if (context.mode === "run") { sealDelivery(delivery, context.facts); return; }
  if (!existsSync(delivery)) throw new Error("rehearsal copy has no delivery to seal");
  const members = treeMembers(delivery, []);
  sealTree(delivery, "REHEARSAL-INVENTORY.json", { schema: "bun-wasm.c1-rehearsal-inventory/1", qualifying: false, producerStatus: null, files: members }, members);
}
