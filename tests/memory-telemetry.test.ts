import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const wrapped = ["malloc", "calloc", "realloc", "free", "aligned_alloc", "posix_memalign"];

function fixture(run: (exports: WebAssembly.Exports, snapshot: () => bigint[]) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-memory-"));
  try {
    const output = join(directory, "allocator.wasm");
    const compiler = process.env.CC_wasm32_wasip1;
    const sysroot = process.env.BUN_WASM_SYSROOT;
    if (!compiler || !sysroot) throw new Error("Source env.sh before allocator controls");
    const built = Bun.spawnSync([compiler, `--sysroot=${sysroot}`, "-O2", "-fno-builtin", "-nostartfiles",
      join(root, "crates/bunwasm-cli/memory-telemetry.c"), "-Wl,--no-entry", "-Wl,--max-memory=262144",
      "-Wl,-z,stack-size=16384", "-Wl,--export=malloc_usable_size", "-Wl,--export=bun_memory_telemetry",
    ].concat(wrapped.flatMap(name => [`-Wl,--wrap=${name}`, `-Wl,--export=${name}`]), ["-o", output]));
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    const module = new WebAssembly.Module(readFileSync(output));
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = imports[entry.module] ??= {};
      if (entry.kind !== "function") throw new Error(`Unexpected ${entry.kind} import`);
      namespace[entry.name] = () => { throw new Error(`Unexpected WASI call ${entry.name}`); };
    }
    const exports = new WebAssembly.Instance(module, imports).exports;
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing memory");
    const snapshot = () => {
      const pointer = call(exports, "bun_memory_telemetry");
      const view = new DataView(memory.buffer, pointer, 80);
      return Array.from({ length: 10 }, (_, index) => view.getBigUint64(index * 8, true));
    };
    run(exports, snapshot);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`Missing ${name}`);
  const result: unknown = fn(...args);
  if (result === undefined) return 0;
  if (typeof result !== "number") throw new Error(`Invalid result from ${name}`);
  return result;
}

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
