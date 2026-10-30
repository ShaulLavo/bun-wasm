import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMemoryReader } from "../web/src/memory-telemetry.ts";
import { createMemoryChannel, createMemoryPublisher, memoryChannelReady, readMemoryChannel, requestMemoryChannel } from "../web/src/memory-channel.ts";
import { selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";
import { checkCommand, discoverChecks, selectChecks } from "./test-checks.ts";
import { checkInputPaths } from "./ci-check-inputs.ts";
import { needsRust } from "./ci-changes.ts";

const unknown = 0xffffffffffffffffn;
const root = resolve(import.meta.dir, "..");

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const put = (base: number, index: number, value: bigint) => new DataView(memory.buffer).setBigUint64(base + index * 8, value, true);
  [1n, 80n, 10000n, 20000n, unknown, 0n, 0n, 0n, 0n, 65536n].forEach((value, index) => put(128, index, value));
  [1n, 64n, 0n, unknown, unknown, unknown, 0n, 0n].forEach((value, index) => put(256, index, value));
  let refreshes = 0;
  let trap = false;
  let disposed = false;
  const core = { exports: { memory, bun_memory_telemetry: () => 128 } };
  const side = { exports: {
    hermes_memory_telemetry: () => { if (disposed) throw new Error("disposed side"); return 256; },
    hermes_memory_telemetry_refresh: () => {
      refreshes++;
      if (trap) throw new WebAssembly.RuntimeError("unreachable");
      put(256, 2, BigInt(refreshes)); put(256, 3, 3000n); put(256, 4, 2097152n); put(256, 5, 1024n); put(256, 6, 1n);
      return 256;
    },
  } };
  return { memory, core, side, put, reader: createMemoryReader("hermes", core, side), refreshes: () => refreshes,
    trap: () => { trap = true; }, dispose: () => { disposed = true; } };
}

test("Hermes cached/refresh readout decodes exactly 64 bytes and preserves counter meanings", () => {
  const f = fixture();
  expect(f.reader.sample().jsHeapBytes).toBeNull();
  expect(f.reader.sample().engineCounters).toEqual({ refreshSequence: 0, heapUsedBytes: null, heapCapacityBytes: null,
    externalBytes: null, countersValid: 0, refreshDisabled: 0 });
  expect(f.refreshes()).toBe(0);
  const sample = f.reader.sample(true);
  expect(sample.jsHeapBytes).toBe(3000);
  expect(sample.engineCounters).toEqual({ refreshSequence: 1, heapUsedBytes: 3000, heapCapacityBytes: 2097152,
    externalBytes: 1024, countersValid: 1, refreshDisabled: 0 });
  expect(sample.arrayBufferBytes).toBeNull(); expect(sample.swcBytes).toBeNull();
  expect(sample.allocatorLiveBytes).toBe(10000); expect(sample.wasmCapacityBytes).toBe(65536);
  for (let index = 0; index < 100; index++) expect(f.reader.sample().jsHeapBytes).toBe(3000);
  expect(f.refreshes()).toBe(1);
  f.put(256, 3, unknown); f.put(256, 4, 9007199254740992n);
  expect(f.reader.sample().jsHeapBytes).toBeNull();
  expect(f.reader.sample().engineCounters.heapCapacityBytes).toBeNull();
  f.put(256, 3, 3000n); f.put(256, 6, 0n);
  expect(f.reader.sample().jsHeapBytes).toBeNull();
});

test("Hermes rejects wrong layout, version, alignment and bounds instead of decoding an old record", () => {
  for (const bytes of [56n, 72n, 96n]) {
    const f = fixture(); f.put(256, 1, bytes);
    expect(() => f.reader.sample()).toThrow("ABI");
  }
  const f = fixture(); f.put(256, 0, 2n);
  expect(() => f.reader.sample()).toThrow("ABI");
  for (const pointer of [257, 65528, -8]) {
    const side = { exports: { hermes_memory_telemetry: () => pointer } };
    expect(() => createMemoryReader("hermes", f.core, side).sample()).toThrow("bounds");
  }
});

test("Hermes preserves exact or unknown libc failures and latches refresh off", () => {
  for (const bytes of [629145600n, unknown]) {
    const f = fixture(); f.reader.sample(true);
    f.put(128, 4, bytes); f.put(128, 5, 2n); f.trap();
    const failed = f.reader.sample(true);
    expect(failed.failedAllocation).toEqual({ bytes: bytes === unknown ? null : 629145600, category: "libc.calloc" });
    expect(failed.engineFailure).toBeNull(); expect(failed.jsHeapBytes).toBe(3000);
    f.put(128, 5, 0n);
    f.reader.sample(true);
    expect(f.refreshes()).toBe(1);
  }
});

test("Hermes refresh trap, growth and terminal reads use the last cached snapshot", () => {
  const f = fixture(); f.reader.sample(true); f.trap();
  expect(() => f.reader.sample(true)).toThrow("unreachable");
  f.memory.grow(1);
  expect(f.reader.sample(true).wasmCapacityBytes).toBe(131072);
  expect(f.reader.sample(true).jsHeapBytes).toBe(3000);
  expect(f.reader.sample().failedAllocation).toBeNull();
  expect(f.refreshes()).toBe(2);
  expect(f.reader.finish().terminal).toBe(true);
  f.reader.sample(true);
  expect(f.refreshes()).toBe(2);
});

test("Hermes channel refreshes only at normal boundaries and freezes before disposal", () => {
  const f = fixture();
  const channel = createMemoryChannel();
  const publisher = createMemoryPublisher(channel, f.reader);
  const generation = requestMemoryChannel(channel, true);
  for (const normal of [false, true]) {
    publisher.capture(normal);
    expect(f.refreshes()).toBe(Number(normal));
    expect(memoryChannelReady(channel, generation, true)).toBe(normal);
  }
  f.put(128, 4, 123456n); f.put(128, 5, 3n);
  publisher.capture(false, true);
  f.put(256, 3, unknown); f.put(256, 6, 0n);
  const terminal = publisher.finish();
  f.dispose();
  expect(terminal?.failedAllocation).toEqual({ bytes: 123456, category: "libc.realloc" });
  expect(terminal?.jsHeapBytes).toBe(3000); expect(readMemoryChannel(channel)).toEqual(terminal);
  expect(f.refreshes()).toBe(1);
});

test("Hermes initializer failure has allocator-only access and no fabricated failure or root", () => {
  const f = fixture();
  const initial = createMemoryReader("hermes", f.core).finish();
  expect(initial.allocatorLiveBytes).toBe(10000); expect(initial.jsHeapBytes).toBeNull();
  expect(initial.engineCounters).toEqual({}); expect(initial.engineFailure).toBeNull(); expect(f.refreshes()).toBe(0);
  const snapshot = f.reader.sample(true);
  const result = selectMemorySnapshots([snapshot], "hermes");
  expect(result.processes).toEqual([snapshot]); expect(result.attribution.kind).toBe("unknown");
  expect(result.jsHeapBytes).toBeNull(); expect(result.memoryLimitBytes).toBeNull();
});

test("Hermes values aggregate only for a complete explicit root and preserve raw failed children", () => {
  const f = fixture();
  const parent = { ...f.reader.sample(true), id: "hermes-root",
    lineage: { authority: "runtime-supervisor", runtimeId: "runtime", pid: 1, parentPid: 0, rootId: "hermes-root", rootPid: 1, ancestry: [1] } };
  const failedAllocation = { bytes: 123456, category: "libc.realloc" };
  const child = { ...parent, id: "hermes-child", terminal: true, failedAllocation, allocatorFailure: failedAllocation,
    lineage: { ...parent.lineage, pid: 2, parentPid: 1, ancestry: [2, 1] } };
  const unrelated = { ...parent, id: "unrelated",
    lineage: { ...parent.lineage, pid: 3, rootId: "unrelated", rootPid: 3, ancestry: [3] } };
  const roots = [{ authority: "runtime-supervisor", complete: true, runtimeId: "runtime", rootId: "hermes-root", rootPid: 1,
    members: [{ pid: 1, parentPid: 0, telemetryId: "hermes-root", terminal: false }, { pid: 2, parentPid: 1, telemetryId: "hermes-child", terminal: true }] }];
  const result = selectMemorySnapshots([unrelated, child, parent], "hermes", "hermes-root", roots);
  expect(result.attribution.kind).toBe("root"); expect(result.jsHeapBytes).toBe(3000);
  expect(result.memoryLimitBytes).toBeNull(); expect(result.arrayBufferBytes).toBeNull(); expect(result.swcBytes).toBeNull();
  expect(result.failedAllocation).toEqual(failedAllocation); expect(result.failureProcessId).toBe("hermes-child");
  expect(result.attributedProcesses.map(process => process.id)).toEqual(["hermes-root", "hermes-child"]);
  expect(result.processes.map(process => process.id)).toEqual(["unrelated", "hermes-child", "hermes-root"]);
});

test("Hermes host checks and compiler controls each retain one provisioned blocking owner", () => {
  const host = "scripts/hermes-memory-telemetry.test.ts";
  const native = "scripts/hermes-memory-telemetry-native.test.ts";
  expect(discoverChecks().filter(check => check.path === host)).toEqual([
    { owner: "quality", path: host, localRuntime: false, batch: "default" },
  ]);
  expect(discoverChecks().filter(check => check.path === native)).toEqual([
    { owner: "runtime", path: native, localRuntime: false, batch: "default" },
  ]);
  expect(selectChecks("quality")).toContain(host);
  expect(selectChecks("quality")).not.toContain(native);
  expect(selectChecks("runtime").filter(path => path === native)).toHaveLength(1);
  expect(selectChecks("local-runtime")).not.toContain(native);
  expect(checkCommand("runtime", [native])).toEqual(["bun", "test", join(root, native)]);
  expect(checkInputPaths({ owner: "runtime", path: native, localRuntime: false, batch: "default" })).toEqual([native]);
  expect(needsRust([native])).toBe(true);
  expect(needsRust(["checks/runtime-hermes-memory-telemetry-native.json"])).toBe(true);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const fixtures = workflow.indexOf("name: Blocking native fixture checks");
  for (const setup of ["uses: dtolnay/rust-toolchain@nightly", "name: Install native build tools"]) {
    const provision = workflow.indexOf(setup);
    expect(provision).toBeGreaterThan(-1);
    expect(fixtures).toBeGreaterThan(provision);
  }
  expect(workflow.match(/bun scripts\/test-checks\.ts native\n/g)).toHaveLength(1);
  const preflight = readFileSync(join(root, "scripts/check-runtime.sh"), "utf8");
  expect(preflight.match(/bun "\$root\/scripts\/test-checks\.ts" runtime\n/g)).toHaveLength(1);
});

test("Hermes exports retain cached and guarded refresh entry points and latch fatal/return paths", () => {
  const source = (path: string) => readFileSync(join(root, path), "utf8");
  const build = source("scripts/build-engine-hermes.sh");
  const vm = source("crates/bunwasm-engine-hermes/src/vm.rs");
  for (const name of ["hermes_memory_telemetry", "hermes_memory_telemetry_refresh"]) {
    expect(build).toMatch(new RegExp(`--export=${name}(?:\\s|$)`));
    expect(vm).toMatch(new RegExp(`#\\[unsafe\\(no_mangle\\)\\]\\s+pub extern "C" fn ${name}\\(`));
  }
  expect(vm).toContain("unsafe { sys::bh_memory_telemetry() }");
  expect(vm).toContain("unsafe { sys::bh_refresh_memory_telemetry() }");
  const shim = source("crates/bunwasm-hermes/cpp/shim.cpp");
  expect(shim).toContain("return memoryTelemetry.cached();");
  expect(shim).toContain("memoryTelemetry.refresh(state && state->rt");
  expect(shim).toMatch(/memoryTelemetry\.stop\(\);\s+bunhermes_host_fatal/);
  expect(source("crates/bunwasm-engine-hermes/src/lib.rs")).toMatch(/driver::run::<vm::Hermes>\(session\);\s+unsafe \{ bunwasm_hermes::bh_stop_memory_telemetry\(\) \}/);
  const refresh = shim.slice(shim.indexOf("const BhMemoryTelemetry *bh_refresh_memory_telemetry()"), shim.indexOf("void bh_stop_memory_telemetry()"));
  expect(refresh).toContain("getHeapInfo(info)");
  expect(refresh).not.toMatch(/collect\(|getHeapInfoWithMallocSize|bh_eval|bh_call/);
});
