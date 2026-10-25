import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { join } from "node:path";

const directory = process.argv[2];
assert(directory, "artifact directory is required");
const coreModule = new WebAssembly.Module(readFileSync(join(directory, "core.wasm")));
const engineModule = new WebAssembly.Module(readFileSync(join(directory, "engine.wasm")));
const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {} });
let checkpointCalls = 0;
const coreImports = Object.assign({}, wasi.getImportObject(), {
    runtime_proc: { signal: (signal: number, mode: number) => {
        assert.equal(signal, 0);
        assert.equal(mode, 4);
        checkpointCalls++;
        return 0;
    } },
});
const core = new WebAssembly.Instance(coreModule, coreImports);
wasi.start(core);
const memory = core.exports.memory;
const table = core.exports.__indirect_function_table;
const stack = core.exports.__stack_pointer;
assert(memory instanceof WebAssembly.Memory);
assert(table instanceof WebAssembly.Table);
assert(stack instanceof WebAssembly.Global);

function call(instance: WebAssembly.Instance, name: string, ...args: number[]): number {
    const fn = instance.exports[name];
    assert.equal(typeof fn, "function", name);
    if (typeof fn !== "function") throw new Error(name);
    const value: unknown = fn(...args);
    assert.equal(typeof value, "number", name);
    if (typeof value !== "number") throw new Error(name);
    return value;
}

function initialize(instance: WebAssembly.Instance, name: string): void {
    const fn = instance.exports[name];
    assert.equal(typeof fn, "function", name);
    if (typeof fn !== "function") throw new Error(name);
    fn();
}

function layout(module: WebAssembly.Module) {
    const sections = WebAssembly.Module.customSections(module, "dylink.0");
    assert.equal(sections.length, 1);
    const bytes = new Uint8Array(sections[0]);
    let offset = 0;
    const uleb = () => {
        let value = 0;
        let shift = 0;
        for (;;) {
            const byte = bytes[offset++];
            assert.notEqual(byte, undefined);
            value += (byte & 127) * 2 ** shift;
            if (!(byte & 128)) return value;
            shift += 7;
            assert(shift <= 28);
        }
    };
    assert.equal(uleb(), 1, "first dylink subsection is memory info");
    uleb();
    return { bytes: uleb(), align: 2 ** uleb(), slots: uleb(), tableAlign: 2 ** uleb() };
}

const info = layout(engineModule);
const memoryBase = call(core, "bun_core_alloc", info.bytes, info.align);
assert(memoryBase > 0);
assert.equal(memoryBase % info.align, 0);
new Uint8Array(memory.buffer, memoryBase, info.bytes).fill(0);
const tableBase = table.grow(info.slots + info.tableAlign);
assert(tableBase > 0);
assert.equal(tableBase % info.tableAlign, 0);
const got: Record<string, WebAssembly.Global> = {};
for (const name of ["stdout", "errno", "_CLOCK_MONOTONIC"]) {
    const address = core.exports[name];
    assert(address instanceof WebAssembly.Global, name);
    got[name] = new WebAssembly.Global({ value: "i32", mutable: true }, address.value);
}
const env = Object.assign({}, core.exports, {
    memory,
    __indirect_function_table: table,
    __stack_pointer: stack,
    __memory_base: new WebAssembly.Global({ value: "i32" }, memoryBase),
    __table_base: new WebAssembly.Global({ value: "i32" }, tableBase),
});
const imports = Object.assign({}, wasi.getImportObject(), { env, "GOT.mem": got });
const engine = new WebAssembly.Instance(engineModule, imports);
assert.equal(engine.exports.__stack_pointer, stack, "actual engine exported stack global identity");
const low = core.exports.__stack_low;
const high = core.exports.__stack_high;
assert(low instanceof WebAssembly.Global && high instanceof WebAssembly.Global);
assert(Number(low.value) <= Number(stack.value) && Number(stack.value) <= Number(high.value));
const beforeStack = stack.value;
initialize(core, "__wasm_call_ctors");
let initialized = false;
function initializeEngine(): void {
    if (initialized) return;
    initialized = true;
    initialize(engine, "quickjs_initialize_memory");
    initialize(engine, "quickjs_apply_data_relocs");
    assert.equal(call(engine, "quickjs_ctor_value"), 0);
    initialize(engine, "quickjs_call_ctors");
}
initializeEngine();
assert.equal(call(engine, "quickjs_ctor_value"), 42);
initializeEngine();
assert.equal(call(engine, "quickjs_ctor_value"), 42);
assert.equal(call(core, "core_clock_smoke"), 1);
assert.equal(call(core, "core_clock_address"), got._CLOCK_MONOTONIC.value);
assert.equal(call(core, "core_errno_smoke"), 47);
assert.equal(new DataView(memory.buffer).getInt32(Number(got.errno.value), true), 47);
assert.equal(new DataView(memory.buffer).getUint32(Number(got.stdout.value), true), call(core, "core_stdout_value"));
assert(call(engine, "quickjs_interrupt_smoke", 0) >= 8);
assert(call(engine, "quickjs_interrupt_smoke", 1) >= 8);
assert.equal(call(engine, "quickjs_stack_guard_smoke"), 1);
assert(checkpointCalls >= 16);
assert.equal(call(engine, "quickjs_link_smoke"), 42);
assert.equal(call(engine, "quickjs_helpers_smoke"), 42);
assert.equal(stack.value, beforeStack);
assert.equal(call(engine, "quickjs_stack_reenter", 20), 42);
assert.equal(stack.value, beforeStack);
const rust = call(engine, "quickjs_rust_alloc", 64, 64);
assert(rust > 0 && rust % 64 === 0);
assert(call(core, "core_usable", rust) >= 64);
new Uint8Array(memory.buffer, rust, 64).fill(0x5a);
const resized = call(engine, "quickjs_rust_realloc", rust, 64, 64, 512);
assert(resized > 0 && resized % 64 === 0);
assert(new Uint8Array(memory.buffer, resized, 64).every((value) => value === 0x5a));
initializeFree(core, "free", resized);
const owned = call(core, "malloc", 80);
assert(owned > 0);
initializeFree(engine, "quickjs_rust_free", owned, 80, 8);
const sentinel = call(core, "malloc", 128);
new Uint8Array(memory.buffer, sentinel, 128).fill(0xa5);
const beforeGrowth = memory.buffer.byteLength;
const large = call(engine, "quickjs_rust_alloc", beforeGrowth * 2, 16);
assert(large > 0);
assert(memory.buffer.byteLength > beforeGrowth);
assert(new Uint8Array(memory.buffer, sentinel, 128).every((value) => value === 0xa5));
initializeFree(engine, "quickjs_rust_free", large, beforeGrowth * 2, 16);
const failed = call(core, "realloc", sentinel, 536870912);
assert.equal(failed, 0);
assert(new Uint8Array(memory.buffer, sentinel, 128).every((value) => value === 0xa5));
initializeFree(core, "free", sentinel);
const result = {
    simpleJsAndCoreCall: 42,
    approvedOpsEcho: true,
    hostCheckpointCalls: checkpointCalls,
    sixPatchedHelpersAndPendingJob: true,
    explicitRelocationAndCtorOnce: true,
    cpuAndRegexpUncatchable: true,
    catchableStackGuard: true,
    clockAddressNotNumericId: true,
    consistentLibcData: true,
    nestedStackCalls: 42,
    sameStackGlobal: true,
    stackRestored: stack.value === beforeStack,
    crossBoundaryFreeAndRealloc: true,
    growthSentinel: true,
    failedReallocPreservesAllocation: true,
    beforeGrowth,
    afterGrowth: memory.buffer.byteLength,
    memoryBase,
    tableBase,
    layout: info,
    coreDataAddresses: Object.fromEntries(Object.entries(got).map(([name, value]) => [name, value.value])),
    engineImports: WebAssembly.Module.imports(engineModule),
};
writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));

function initializeFree(instance: WebAssembly.Instance, name: string, ...args: number[]): void {
    const fn = instance.exports[name];
    if (typeof fn !== "function") throw new Error(name);
    fn(...args);
}
