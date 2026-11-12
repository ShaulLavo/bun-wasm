import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoryMaximumBytes } from "../src/engine-kind.ts";
import { beginMemorySnapshot, createMemoryReader, endMemorySnapshot, recordMemorySnapshot, registerMemoryProcess, retainedMemoryProcesses } from "../web/src/memory-telemetry.ts";
import { createMemoryPublisher, readMemoryChannel } from "../web/src/memory-channel.ts";
import { decodeMemoryObservation } from "../scripts/goals-matrix/browser-memory.ts";

const root = resolve(import.meta.dir, "..");
const linkSource = readFileSync(join(root, "crates/bunwasm-cli/build.rs"), "utf8");
const linkNames = /for name in \[([^\]]+)\]\s*\{\s*println!\("cargo:rustc-link-arg-bin=bun=--wrap=\{name\}"\);/s.exec(linkSource)?.[1];
if (!linkNames) throw new Error("Missing allocator link wiring");
const wrapped = Array.from(linkNames.matchAll(/"([a-z_]+)"/g), match => match[1]!);

function fixture(run: (exports: WebAssembly.Exports, snapshot: () => bigint[], limitBytes: number | null) => void, controlledRealloc = false): void {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-memory-"));
  try {
    const output = join(directory, "allocator.wasm");
    const compiler = process.env.CC_wasm32_wasip1;
    const sysroot = process.env.BUN_WASM_SYSROOT;
    if (!compiler || !sysroot) throw new Error("Source env.sh before allocator controls");
    const control = join(directory, "control.c");
    if (controlledRealloc) writeFileSync(control, reallocControl);
    const built = Bun.spawnSync([compiler, `--sysroot=${sysroot}`, "-O2", "-Wall", "-Wextra", "-Werror", "-fno-builtin", "-nostartfiles",
      join(root, "crates/bunwasm-cli/memory-telemetry.c"), "-Wl,--no-entry", "-Wl,--max-memory=262144",
      "-Wl,-z,stack-size=16384", "-Wl,--export=malloc_usable_size", "-Wl,--export=bun_memory_telemetry",
      "-Wl,--export=__wrap_sbrk",
    ].concat(wrapped.flatMap(name => [`-Wl,--wrap=${name}`, `-Wl,--export=${name}`]),
      controlledRealloc ? ["-D__real_realloc=fixture_realloc", control] : [], ["-o", output]));
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    const bytes = readFileSync(output);
    const exports = instantiateAllocator(bytes);
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing memory");
    const snapshot = () => {
      const pointer = call(exports, "bun_memory_telemetry");
      const view = new DataView(memory.buffer, pointer, 80);
      return Array.from({ length: 10 }, (_, index) => view.getBigUint64(index * 8, true));
    };
    run(exports, snapshot, memoryMaximumBytes(bytes) ?? null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function instantiateAllocator(bytes: Uint8Array<ArrayBuffer>): WebAssembly.Exports {
  const module = new WebAssembly.Module(bytes);
  const imports: WebAssembly.Imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.kind !== "function") throw new Error(`Unexpected ${entry.kind} import`);
    namespace[entry.name] = () => { throw new Error(`Unexpected WASI call ${entry.name}`); };
  }
  return new WebAssembly.Instance(module, imports).exports;
}

// Only realloc's result is controlled. Nested allocation and all sbrk calls use real WASI libc.
const reallocControl = `
#include <stdint.h>
#include <stddef.h>
#include <errno.h>
void *__wrap_malloc(size_t);
void *__wrap_calloc(size_t, size_t);
void __wrap_free(void *);
void *sbrk(intptr_t);
void *fixture_realloc(void *previous, size_t size) {
    (void) previous;
    errno = 123;
    if (size == 1) {
        void *nested = __wrap_malloc(32);
        __wrap_calloc(SIZE_MAX, 2);
        sbrk(1048576);
        __wrap_free(nested);
    }
    sbrk(65536);
    sbrk(0);
    return NULL;
}
__attribute__((export_name("fixture_errno"))) int fixture_errno(void) { return errno; }
`;

function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`Missing ${name}`);
  const result: unknown = fn(...args);
  if (result === undefined) return 0;
  if (typeof result !== "number") throw new Error(`Invalid result from ${name}`);
  return result;
}

function failureSnapshot(exports: WebAssembly.Exports): bigint[] {
  const pointer = call(exports, "bun_memory_failure_telemetry");
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing memory");
  const view = new DataView(memory.buffer, pointer, 104);
  return Array.from({ length: 13 }, (_, index) => view.getBigUint64(index * 8, true));
}

test("real libc distinguishes refused positive growth from rejection without growth", () => {
  fixture((exports) => {
    expect(call(exports, "malloc", 1048576)).toBe(0);
    const frozen = createMemoryReader("quickjs", { exports }, undefined, 262144).sample().frozenAllocatorFailure;
    expect(frozen).toMatchObject({ growth: { kind: "attempted", failedAttempts: expect.any(Number),
      firstFailedIncrementBytes: expect.any(Number) } });
  });
  fixture((exports) => {
    const pointer = call(exports, "malloc", 70000);
    expect(pointer).not.toBe(0);
    expect(call(exports, "__wrap_sbrk", 1048576)).toBe(-1);
    call(exports, "__wrap_sbrk", 0);
    expect(call(exports, "calloc", 0xffffffff, 2)).toBe(0);
    expect(createMemoryReader("quickjs", { exports }, undefined, 262144).sample().frozenAllocatorFailure)
      .toMatchObject({ growth: { kind: "not-attempted" } });
    call(exports, "free", pointer);
  });
});

test("nested requests share the outer growth record, and later success or query cannot hide refusal", () => {
  fixture((exports, snapshot) => {
    expect(call(exports, "realloc", 0, 1)).toBe(0);
    expect(call(exports, "fixture_errno")).toBe(48); // WASI ENOMEM survives success, query and observation.
    expect(snapshot().slice(4, 8)).toEqual([1n, 3n, 1n, 0n]);
    const reader = createMemoryReader("quickjs", { exports }, undefined, 262144);
    const frozen = reader.sample().frozenAllocatorFailure;
    expect(frozen).toMatchObject({ bytes: 1, category: "libc.realloc", growth: {
      kind: "attempted", successfulAttempts: 1, failedAttempts: 1, lastIncrementBytes: 65536, firstFailedIncrementBytes: 1048576,
    } });
    expect(call(exports, "__wrap_sbrk", 0)).toBeGreaterThan(0);
    call(exports, "__wrap_sbrk", 1048576);
    const later = call(exports, "malloc", 16);
    call(exports, "free", later);
    expect(reader.finish().frozenAllocatorFailure).toEqual(frozen);
  }, true);
});

test("successful growth followed by an outer rejection stays distinct from failed growth", () => {
  fixture((exports) => {
    expect(call(exports, "realloc", 0, 2)).toBe(0);
    expect(call(exports, "fixture_errno")).toBe(123);
    expect(createMemoryReader("quickjs", { exports }, undefined, 262144).sample().frozenAllocatorFailure)
      .toMatchObject({ growth: { kind: "attempted", successfulAttempts: 1, failedAttempts: 0,
        lastIncrementBytes: 65536, firstFailedIncrementBytes: null } });
  }, true);
});

test("first libc failure freezes old realloc ownership and failure-time counters", () => {
  fixture((exports, snapshot) => {
    const unknown = 0xffffffffffffffffn;
    expect(failureSnapshot(exports)).toEqual([2n, 104n, unknown, 0n, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown]);
    const pointer = call(exports, "malloc", 4000);
    const before = snapshot();
    expect(call(exports, "realloc", pointer, 1048576)).toBe(0);
    const frozen = failureSnapshot(exports);
    expect(frozen.slice(0, 9)).toEqual([2n, 104n, 1048576n, 3n, before[2]!, before[2]!, before[3]!, before[9]!, snapshot()[9]!]);
    const later = call(exports, "malloc", 32);
    expect(later).not.toBe(0);
    call(exports, "free", pointer);
    expect(snapshot()[2]).toBeLessThan(before[2]!);
    expect(call(exports, "malloc", 2097152)).toBe(0);
    expect(failureSnapshot(exports)).toEqual(frozen);
    const counts = snapshot();
    failureSnapshot(exports);
    expect(snapshot()).toEqual(counts);
    call(exports, "free", later);
  });
});

test("first failure keeps realloc-null distinct from a non-realloc request", () => {
  fixture((exports, snapshot) => {
    const before = snapshot();
    expect(call(exports, "realloc", 0, 1048576)).toBe(0);
    expect(failureSnapshot(exports).slice(0, 9)).toEqual([2n, 104n, 1048576n, 3n, 0n, 0n, 0n, before[9]!, snapshot()[9]!]);
  });
  fixture((exports, snapshot) => {
    expect(call(exports, "calloc", 0xffffffff, 2)).toBe(0);
    expect(failureSnapshot(exports)).toEqual([
      2n, 104n, 0xffffffffffffffffn, 2n, 0n, 0n, 0n, 0xffffffffffffffffn, snapshot()[9]!,
      0n, 0n, 0xffffffffffffffffn, 0xffffffffffffffffn,
    ]);
  });
});

test("allocator control: separated holes can reject realloc below the memory maximum", () => {
  fixture((exports, snapshot) => {
    const first = call(exports, "malloc", 40000);
    const old = call(exports, "malloc", 40000);
    const hole = call(exports, "malloc", 40000);
    const blocker = call(exports, "malloc", 40000);
    expect([first, old, hole, blocker].every(pointer => pointer !== 0)).toBe(true);
    call(exports, "free", first);
    call(exports, "free", hole);
    const before = snapshot();
    expect(before[9]).toBe(196608n);
    expect(before[9]! - before[2]!).toBeGreaterThan(100000n);
    expect(call(exports, "realloc", old, 100000)).toBe(0);
    expect(snapshot()[9]).toBe(before[9]);
    expect(snapshot()[2]).toBe(before[2]);
    expect(failureSnapshot(exports).slice(4, 9)).toEqual([
      BigInt(call(exports, "malloc_usable_size", old)), before[2]!, before[3]!, before[9]!, before[9]!,
    ]);
    call(exports, "free", blocker);
    expect(call(exports, "realloc", old, 100000)).toBe(old);
    expect(snapshot()[9]).toBe(before[9]);
    call(exports, "free", old);
    expect(snapshot()[2]).toBe(0n);
  });
});

test("allocator control: realloc replacement can fail when a growth delta would fit", () => {
  fixture((exports, snapshot) => {
    const old = call(exports, "malloc", 140000);
    expect(old).not.toBe(0);
    const before = snapshot();
    expect(before[9]).toBe(196608n);
    expect(262144n - before[9]!).toBeGreaterThan(200000n - before[2]!);
    expect(call(exports, "realloc", old, 200000)).toBe(0);
    expect(snapshot()[9]).toBe(before[9]);
    expect(snapshot()[2]).toBe(before[2]);
    call(exports, "free", old);
    expect(snapshot()[2]).toBe(0n);
  });
});

test("libc allocations track usable live/peak, realloc failure preserves ownership and first request", () => {
  fixture((exports, snapshot) => {
    expect(snapshot().slice(0, 4)).toEqual([1n, 80n, 0n, 0n]);
    const pointer = call(exports, "malloc", 31);
    const charged = BigInt(call(exports, "malloc_usable_size", pointer));
    expect(charged).toBeGreaterThanOrEqual(31n);
    expect(snapshot()[2]).toBe(charged);
    const larger = call(exports, "realloc", pointer, 4000);
    const largerCharge = BigInt(call(exports, "malloc_usable_size", larger));
    expect(snapshot()[2]).toBe(largerCharge);
    expect(call(exports, "realloc", larger, 1048576)).toBe(0);
    const failed = snapshot();
    expect(failed.slice(2, 6)).toEqual([largerCharge, largerCharge, 1048576n, 3n]);
    expect(call(exports, "malloc", 2097152)).toBe(0);
    expect(snapshot().slice(4, 6)).toEqual([1048576n, 3n]);
    call(exports, "free", larger);
    const freed = snapshot();
    expect(freed[2]).toBe(0n);
    expect(freed[3]).toBe(largerCharge);
    expect(freed[6]).toBe(2n);
    expect(freed[7]).toBe(2n);
    expect(freed[8]).toBe(1n);
    expect(freed[9]).toBeGreaterThan(freed[3]!);
  });
});

test("calloc overflow records unknown size and does not overwrite it during diagnostic allocations", () => {
  fixture((exports, snapshot) => {
    expect(call(exports, "calloc", 0xffffffff, 2)).toBe(0);
    expect(snapshot().slice(4, 6)).toEqual([0xffffffffffffffffn, 2n]);
    expect(call(exports, "malloc", 0x7fffffff)).toBe(0);
    expect(snapshot().slice(4, 6)).toEqual([0xffffffffffffffffn, 2n]);
  });
});

test("aligned allocation and zero-sized realloc retain libc behavior without duplicate accounting", () => {
  fixture((exports, snapshot) => {
    const pointer = call(exports, "aligned_alloc", 64, 256);
    expect(pointer % 64).toBe(0);
    expect(snapshot()[2]).toBe(BigInt(call(exports, "malloc_usable_size", pointer)));
    expect(snapshot()[7]).toBe(1n);
    const resized = call(exports, "realloc", pointer, 0);
    if (resized) call(exports, "free", resized);
    expect(snapshot()[2]).toBe(0n);
    expect(snapshot()[5]).toBe(0n);
    call(exports, "free", 0);
    expect(snapshot()[2]).toBe(0n);
  });
});

test("libc internal aliases share the same accounting as the exported allocator", () => {
  fixture((exports, snapshot) => {
    const pointer = call(exports, "__libc_calloc", 8, 128);
    expect(snapshot()[2]).toBe(BigInt(call(exports, "malloc_usable_size", pointer)));
    call(exports, "free", pointer);
    expect(snapshot()[2]).toBe(0n);
    const next = call(exports, "malloc", 32);
    call(exports, "__libc_free", next);
    expect(snapshot()[2]).toBe(0n);
    expect(snapshot()[7]).toBe(2n);
    expect(snapshot()[8]).toBe(2n);
  });
});

test("compiled core frozen record reaches the browser reader and shared host channel", () => {
  fixture((exports, snapshot, limitBytes) => {
    const id = crypto.randomUUID();
    const runtime = { disposed: false };
    registerMemoryProcess("quickjs", id, runtime, { pid: 1, parentPid: 0, job: 1 }, { workerMemory: () => [] });
    const transport = beginMemorySnapshot("quickjs", id);
    if (!transport) throw Error("Missing shared telemetry");
    try { verifyCompiledChannel(exports, snapshot, limitBytes, transport); }
    finally { endMemorySnapshot(id); }
  });
});

function verifyCompiledChannel(exports: WebAssembly.Exports, snapshot: () => bigint[], limitBytes: number | null,
  transport: NonNullable<ReturnType<typeof beginMemorySnapshot>>): void {
  const reader = createMemoryReader("quickjs", { exports }, undefined, limitBytes, transport);
  const channel = transport.buffer;
  const publisher = createMemoryPublisher(channel, reader);
  expect(reader.sample().frozenAllocatorFailure).toBeNull();
  expect(reader.sample().memoryLimitBytes).toBe(262144);
  const pointer = call(exports, "malloc", 4000);
  const before = snapshot();
  expect(call(exports, "realloc", pointer, 1048576)).toBe(0);
  const failed = publisher.capture(false, true);
  expect(failed?.memoryLimitBytes).toBe(limitBytes);
  expect(failed?.frozenAllocatorFailure).toMatchObject({ bytes: 1048576, category: "libc.realloc",
    previousUsableBytes: Number(before[2]), allocatorLiveBytes: Number(before[2]), allocatorPeakBytes: Number(before[3]),
    wasmCapacityBeforeBytes: Number(before[9]), wasmCapacityAfterBytes: Number(snapshot()[9]), reason: "unknown" });
  call(exports, "free", pointer);
  const terminal = publisher.finish();
  expect(terminal?.allocatorLiveBytes).toBe(0);
  expect(terminal?.memoryLimitBytes).toBe(limitBytes);
  expect(terminal?.frozenAllocatorFailure).toEqual(failed?.frozenAllocatorFailure);
  expect(readMemoryChannel(channel)).toEqual(terminal);
  expect(recordMemorySnapshot({ type: "bun-memory", snapshot: terminal }, transport.id)).toBe(true);
  const decoded = decodeMemoryObservation(retainedMemoryProcesses());
  if (decoded.status !== "observed") throw Error(`Invalid observation: ${decoded.reason}`);
  expect(decoded.observation.processes.find(row => row.id === transport.id)?.sample?.frozenAllocatorFailure)
    .toEqual(terminal?.frozenAllocatorFailure);
}
