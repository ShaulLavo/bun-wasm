import type { prepareLinkPlan, LinkPlanSource, PreparedLinkPlan } from "waffle/link";
import { appendCustomSection, programEngineDeclaration, programKind, programProfile, SHARED_GROUP_CORE_INITIALIZE_MEMORY, sharedGroupPair, verifyProgramSide, type PairedProgramFiles } from "./engine-kind.ts";

/** Own both snapshots through pair identity, preparation and compiled-side validation. */
// The consuming runtime must issue the plan through its own SDK instance.
export async function engineLinkPlan(files: PairedProgramFiles<Uint8Array>, prepare: typeof prepareLinkPlan): Promise<{ source: LinkPlanSource; plan: PreparedLinkPlan }> {
  const input = { kind: files.kind, core: Uint8Array.from(files.core), side: Uint8Array.from(files.side) };
  if (programEngineDeclaration(input.core) !== input.kind) throw new TypeError("Program kind does not match core declaration");
  const group = sharedGroupPair(input.core, input.side);
  const digests = await Promise.all([input.core, input.side].map(bytes => crypto.subtle.digest("SHA-256", bytes)));
  const kind = new TextEncoder().encode(input.kind);
  const identity = Uint8Array.from(Array.from(kind).concat([0], Array.from(new Uint8Array(digests[0]!)), Array.from(new Uint8Array(digests[1]!))));
  const source = linkPlan({ ...input, core: appendCustomSection(input.core, "bun-wasm-pair", identity) }, group);
  const plan = await prepare(source);
  if (programKind(plan.entryModule) !== input.kind) throw new TypeError("Program kind does not match core declaration");
  sharedGroupPair(plan.entryModule, input.side);
  verifyProgramSide(input.kind, plan.memberModule(input.kind));
  return { source, plan };
}

/** A shared-group plan is admitted only by Waffle's group loader, which refuses growth and memory exports. */
function linkPlan(files: PairedProgramFiles<Uint8Array>, group: boolean): LinkPlanSource {
  return {
    core: {
      id: "bun-core", source: files.core, cooperative: true,
      checkpoint: { module: "runtime_proc", name: "signal" },
      initializeMemory: group ? SHARED_GROUP_CORE_INITIALIZE_MEMORY.slice() : [],
      initialize: ["__wasm_call_ctors"],
    },
    libraries: [{
      id: files.kind, source: files.side, cooperative: true,
      checkpoint: { module: "env", name: "core_checkpoint" },
      initializeMemory: programProfile(files.kind).initializeMemory.slice(),
      initialize: programProfile(files.kind).initialize.slice(),
    }],
    reserve: "bun_core_alloc",
  };
}
