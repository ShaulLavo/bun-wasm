import type { LinkPlanSource } from "waffle/link";

const QUICKJS_ASSOCIATION_SECTION = "bun-wasm-quickjs";

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}

/**
 * Gives Waffle's byte-keyed module cache an exact owner for each QuickJS side module.
 * The published core bytes stay untouched; this only decorates the in-memory module input
 * used for preparation so two valid side modules cannot overwrite one another's association.
 */
export async function quickjsProgramSource(core: Uint8Array, quickjs: Uint8Array): Promise<LinkPlanSource> {
  const coreBytes = Uint8Array.from(core);
  const sideBytes = Uint8Array.from(quickjs);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sideBytes));
  const name = new TextEncoder().encode(QUICKJS_ASSOCIATION_SECTION);
  const payload = Uint8Array.from(unsigned(name.length).concat(Array.from(name), Array.from(digest)));
  const section = Uint8Array.from([0].concat(unsigned(payload.length), Array.from(payload)));
  const decorated = new Uint8Array(coreBytes.length + section.length);
  decorated.set(coreBytes);
  decorated.set(section, coreBytes.length);
  return quickjsLinkPlan(decorated, sideBytes);
}

export function quickjsLinkPlan(core: Uint8Array, quickjs: Uint8Array): LinkPlanSource {
  return {
    core: {
      id: "bun-core", source: core, cooperative: true,
      checkpoint: { module: "runtime_proc", name: "signal" },
      initialize: ["__wasm_call_ctors"],
    },
    libraries: [{
      id: "quickjs", source: quickjs, cooperative: true,
      checkpoint: { module: "env", name: "core_checkpoint" },
      initialize: ["quickjs_initialize_memory", "quickjs_apply_data_relocs", "quickjs_call_ctors", "quickjs_register"],
    }],
    reserve: "bun_core_alloc",
  };
}
