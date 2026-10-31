import type { LinkPlanSource } from "waffle/link";
import { appendCustomSection, programKind, programProfile, SHARED_GROUP_CORE_INITIALIZE, sharedGroupPair, verifyProgramSide, type PairedProgramFiles } from "./engine-kind.ts";

/** Snapshot both inputs before hashing; the cache association owns kind and both exact bytes. */
export async function engineLinkPlan(files: PairedProgramFiles<Uint8Array>): Promise<LinkPlanSource> {
  const input = { kind: files.kind, core: Uint8Array.from(files.core), side: Uint8Array.from(files.side) };
  // Browser main threads refuse synchronous compilation of modules over 8 MB.
  const [core, side] = await Promise.all([WebAssembly.compile(input.core), WebAssembly.compile(input.side)]);
  if (programKind(core) !== input.kind) throw new TypeError("Program kind does not match core declaration");
  verifyProgramSide(input.kind, side);
  const group = sharedGroupPair(core, input.side);
  if (group && input.kind !== "quickjs") throw new TypeError(`A ${input.kind} pair is not qualified for the shared-group profile`);
  const digests = await Promise.all([input.core, input.side].map(bytes => crypto.subtle.digest("SHA-256", bytes)));
  const kind = new TextEncoder().encode(input.kind);
  const identity = Uint8Array.from(Array.from(kind).concat([0], Array.from(new Uint8Array(digests[0]!)), Array.from(new Uint8Array(digests[1]!))));
  return linkPlan({ ...input, core: appendCustomSection(input.core, "bun-wasm-pair", identity) }, group);
}

/** A shared-group plan is admitted only by Waffle's group loader, which refuses growth and memory exports. */
function linkPlan(files: PairedProgramFiles<Uint8Array>, group: boolean): LinkPlanSource {
  return {
    core: {
      id: "bun-core", source: files.core, cooperative: true,
      checkpoint: { module: "runtime_proc", name: "signal" },
      initialize: group ? SHARED_GROUP_CORE_INITIALIZE.slice() : ["__wasm_call_ctors"],
    },
    libraries: [{
      id: files.kind, source: files.side, cooperative: true,
      checkpoint: { module: "env", name: "core_checkpoint" },
      initialize: programProfile(files.kind).initialize.slice(),
    }],
    reserve: "bun_core_alloc",
  };
}
