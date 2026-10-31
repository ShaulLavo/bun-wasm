import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = process.env.BUNWASM_HOST_SOURCE ?? resolve(import.meta.dir, "../crates/bunwasm-runtime/src/host.rs");
const source = readFileSync(sourcePath, "utf8");

const writableBufferCalls = [
  "call(slot_id, [handle, ptr_mut(&mut buf), buf.len() as i32, 0])",
  "call(Slot::Read, [handle, ptr_mut(&mut buf), cap as i32, 0])",
  "runtime_proc::read(fd, ptr_mut(&mut buf), cap as i32)",
];

test("host read output calls use the shared mutable-pointer helper", () => {
  expect(source).toContain("fn ptr_mut<T>(values: &mut [T]) -> i32");
  for (const call of writableBufferCalls) expect(source).toContain(call);
  expect(source).not.toContain("ptr(&buf)");
});
