import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { writeNativeProof } from "./shared-sysroot-native.ts";

const PAGE = 65536;
const GUEST = { gate: 64, value: 68 } as const;
const CONTROL = { churn: 0, postChurn: 1, intent: 2, wakeAck: 3, valueReady: 4 } as const;
const DELAY_BEFORE_WAIT_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 5000;
type Range = { owner: number; start: number; end: number };

function u32(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[cursor.offset++];
    assert(byte !== undefined && shift <= 28);
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
}

function imageInfo(module: WebAssembly.Module) {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  assert.equal(sections.length, 1);
  const section = sections[0];
  assert(section);
  const bytes = new Uint8Array(section);
  const cursor = { offset: 0 };
  assert.equal(u32(bytes, cursor), 1);
  u32(bytes, cursor);
  const size = u32(bytes, cursor);
  const align = 2 ** u32(bytes, cursor);
  const tableSize = u32(bytes, cursor);
  assert(align <= PAGE);
  return { size, tableSize };
}

function rangesFrom(value: unknown): Range[] {
  assert(Array.isArray(value));
  return value.map((item: unknown) => {
    assert(Array.isArray(item) && item.length === 3);
    const [owner, start, end]: unknown[] = item;
    assert(typeof owner === "number" && typeof start === "number" && typeof end === "number");
    assert(start > 0 && end > start);
    return { owner, start, end };
  });
}

async function receive(worker: Worker): Promise<Range[]> {
  return new Promise((resolve, reject) => {
    let received = false;
    worker.once("message", (message: unknown) => { received = true; resolve(rangesFrom(message)); });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0 || !received) reject(new Error(`Member exited ${code} without completing proof`));
    });
  });
}

async function main() {
  const path = process.argv[2];
  assert(path, "Expected member.wasm path");
  const bytes = readFileSync(path);
  const module = await WebAssembly.compile(bytes);
  const wast = process.argv[3];
  if (wast) { writeNativeProof(wast, bytes, imageInfo(module)); return; }
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4096, shared: true });
  const control = new SharedArrayBuffer(32);
  const workers = [1, 2].map(id => new Worker(new URL(import.meta.url), { workerData: { id, memory, control, module } }));
  try {
    const results = await Promise.all(workers.map(receive));
    const ranges = results.flat();
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      const previous = ranges[i - 1], next = ranges[i];
      assert(previous && next && previous.end <= next.start, "member reservations overlap");
    }
    console.log(JSON.stringify({ pass: true, host: "node", pages: memory.buffer.byteLength / PAGE, ranges: ranges.length,
      checks: ["real-dlmalloc", "all-blocks-owned", "no-overlap", "private-data", "data-relocations", "private-tables", "private-stacks", "private-break", "ENOMEM", "concurrent-churn", "free-reuse", "wait-notify", "delayed-waiter-250ms", "not-equal", "timed-out"] }));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

function barrier(control: Int32Array, index: number) {
  Atomics.add(control, index, 1);
  Atomics.notify(control, index);
  while (Atomics.load(control, index) < 2) {
    const observed = Atomics.load(control, index);
    if (observed < 2) Atomics.wait(control, index, observed, 10000);
  }
}

function member() {
  const data: unknown = workerData;
  assert(data && typeof data === "object" && "id" in data && "memory" in data && "control" in data && "module" in data);
  const { id, memory, control, module } = data;
  assert((id === 1 || id === 2) && memory instanceof WebAssembly.Memory && control instanceof SharedArrayBuffer && module instanceof WebAssembly.Module);
  const ctl = new Int32Array(control);
  const info = imageInfo(module);
  const ranges: Range[] = [];
  const sharedMemory = memory, owner = id;
  function reserve(pages: number): number {
    const start = sharedMemory.grow(pages + 1) * PAGE;
    ranges.push({ owner, start, end: start + pages * PAGE });
    return start;
  }
  const base = reserve(Math.ceil(info.size / PAGE));
  const stackLow = reserve(2), stackHigh = stackLow + 2 * PAGE;
  const tableBase = id * 4;
  const table = new WebAssembly.Table({ initial: tableBase + info.tableSize, element: "anyfunc" });
  const global = (value: number, mutable = false) => new WebAssembly.Global({ value: "i32", mutable }, value);
  let denyGrowth = false, blocks = 0, growthCalls = 0;
  const heap: Range[] = [];
  const instance = new WebAssembly.Instance(module, {
    env: { memory, __indirect_function_table: table, __memory_base: global(base), __table_base: global(tableBase), __stack_pointer: global(stackHigh, true) },
    runtime_shm: { group_grow(pages: number) {
      if (denyGrowth) return -48;
      assert(pages > 0);
      const start = reserve(pages);
      heap.push({ owner: id, start, end: start + pages * PAGE });
      growthCalls++;
      return start / PAGE;
    } },
    j2_probe: { block(addr: number, size: number) {
      assert(heap.some(chunk => addr >= chunk.start && addr + size <= chunk.end), `member ${id} block outside owned chunk`);
      blocks++;
    } },
  });
  function call(name: string, ...args: (number | bigint)[]): number {
    const fn = instance.exports[name];
    assert(typeof fn === "function", name);
    const value: unknown = fn(...args);
    assert(typeof value === "number" || value === undefined);
    return value ?? 0;
  }
  call("__wasm_apply_data_relocs");
  call("__wasm_call_ctors");
  assert.equal(call("member_init", id), 7 + id);
  assert.equal(call("member_greeting_ok"), 1);
  assert.equal(call("member_call_op", 7), id === 1 ? 14 : 21);
  const counterAddr = call("member_counter_addr"), errnoAddr = call("member_errno_addr");
  assert(counterAddr >= base && counterAddr < base + info.size);
  assert(errnoAddr >= base && errnoAddr < base + info.size);
  assert.equal(call("member_stack", id), id * 64);
  const stackAddr = call("member_stack_addr");
  assert(stackAddr >= stackLow && stackAddr < stackHigh);
  const chunk = call("member_grow");
  const ownBreak = call("member_break");
  assert.equal(ownBreak, chunk + PAGE);
  memory.grow(1);
  assert.equal(call("member_break"), ownBreak, "another growth changed this member's break");
  denyGrowth = true;
  assert.equal(call("member_growth_failure"), 1);
  denyGrowth = false;
  barrier(ctl, CONTROL.churn);
  assert.equal(call("member_churn", id, 8), 0);
  const growthAfterChurn = growthCalls;
  assert.equal(call("member_churn", id, 1), 0);
  assert.equal(growthCalls, growthAfterChurn, "free blocks were not reused");
  assert.equal(call("member_counter"), 7 + id);
  assert.equal(call("member_call_op", 7), id === 1 ? 14 : 21);
  barrier(ctl, CONTROL.postChurn);
  futex(call, ctl, id);
  console.log(JSON.stringify({ id, base, counterAddr, errnoAddr, stackLow, stackAddr, tableBase, growthCalls, blocks, churn: 0 }));
  assert(parentPort);
  parentPort.postMessage(ranges.map(chunk => [chunk.owner, chunk.start, chunk.end]));
}

function waitForControl(ctl: Int32Array, index: number): void {
  const deadline = performance.now() + HANDSHAKE_TIMEOUT_MS;
  while (Atomics.load(ctl, index) !== 1) {
    const remaining = deadline - performance.now();
    assert(remaining > 0, `handshake control ${index} timed out`);
    Atomics.wait(ctl, index, 0, remaining);
  }
}

function notifyUntilWoken(call: (name: string, ...args: (number | bigint)[]) => number, ctl: Int32Array): void {
  const deadline = performance.now() + HANDSHAKE_TIMEOUT_MS;
  while (call("member_notify", GUEST.gate, 1) === 0) {
    assert(performance.now() < deadline, "guest waiter was not observed before handshake deadline");
    Atomics.wait(ctl, 7, 0, 1);
  }
}

function futex(call: (name: string, ...args: (number | bigint)[]) => number, ctl: Int32Array, id: number): void {
  if (id === 2) {
    waitForControl(ctl, CONTROL.intent);
    notifyUntilWoken(call, ctl);
    waitForControl(ctl, CONTROL.wakeAck);
    assert.equal(call("member_add", GUEST.value, 1), 0);
    Atomics.store(ctl, CONTROL.valueReady, 1);
    Atomics.notify(ctl, CONTROL.valueReady);
    return;
  }
  Atomics.store(ctl, CONTROL.intent, 1);
  Atomics.notify(ctl, CONTROL.intent);
  Atomics.wait(ctl, 7, 0, DELAY_BEFORE_WAIT_MS);
  assert.equal(call("member_wait32", GUEST.gate, 0, 5_000_000_000n), 0);
  assert.equal(call("member_load", GUEST.gate), 0);
  Atomics.store(ctl, CONTROL.wakeAck, 1);
  Atomics.notify(ctl, CONTROL.wakeAck);
  waitForControl(ctl, CONTROL.valueReady);
  assert.equal(call("member_load", GUEST.value), 1);
  assert.equal(call("member_wait32", GUEST.value, 0, 0n), 1);
  assert.equal(call("member_wait32", GUEST.value, 1, 1_000_000n), 2);
}

if (isMainThread) await main();
else member();
