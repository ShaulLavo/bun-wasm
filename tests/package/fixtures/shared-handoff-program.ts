import { prepareLinkPlan } from "waffle/link";
import { tagProgramCore } from "../../../src/engine-kind.ts";

const leb = (value: number): number[] => value < 128 ? [value] : [(value % 128) + 128].concat(leb(Math.floor(value / 128)));
const name = (value: string) => leb(value.length).concat(Array.from(new TextEncoder().encode(value)));
const vector = (items: number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const body = (ops: number[]) => leb(ops.length + 2).concat([0], ops, [0x0b]);

/** Executable imported-memory PIE control, adapted from Waffle's memory-group-pie fixture. */
export async function sharedHandoffProgram() {
  const env = (field: string, descriptor: number[]) => name("env").concat(name(field), descriptor);
  const source = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(0, name("dylink.0").concat([1, 4, 16, 2, 0, 0])),
    section(1, vector([[0x60, 0, 0], [0x60, 2, 0x7f, 0x7f, 1, 0x7f], [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f]])),
    section(2, vector([
      name("test").concat(name("check"), [0, 0]),
      name("bun_package_scripts").concat(name("handoff"), [0, 2]),
      name("runtime_shm").concat(name("group_grow"), [0, 3]),
      name("wasi_snapshot_preview1").concat(name("args_sizes_get"), [0, 1]),
      env("memory", [2, 3, 1].concat(leb(32768))),
      env("__indirect_function_table", [1, 0x70, 0, 1]),
      env("__stack_pointer", [3, 0x7f, 1]), env("__memory_base", [3, 0x7f, 0]), env("__table_base", [3, 0x7f, 0]),
    ])),
    section(3, vector([[1], [0]])),
    section(7, vector([name("reserve").concat([0, 4]), name("bun_core_bind_engine").concat([0, 4]),
      name("bun_core_alloc").concat([0, 4]), name("bun_core_free").concat([0, 4]), name("bun_nested_dispatch").concat([0, 4]), name("_start").concat([0, 5])])),
    section(10, vector([body([0x41, 0]), body([0x10, 0])])),
  ));
  const plan = await prepareLinkPlan({ core: { id: "bun-core", source: tagProgramCore(source, "quickjs"), cooperative: true,
    checkpoint: { module: "test", name: "check" }, initializeMemory: [], initialize: [] }, libraries: [], reserve: "reserve" });
  return { module: plan.entryModule, linkPlan: plan.shared };
}
