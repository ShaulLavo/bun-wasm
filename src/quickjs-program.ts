import type { LinkPlanSource } from "waffle/link";

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
