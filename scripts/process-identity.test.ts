import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { sourceRuntime } from "./fixtures/stream-consumers-runtime.ts";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-process-identity-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("actual process factory reads its bound nonconstant identity once and preserves public property behavior", () => {
  let calls = 0;
  const pair: [number, number] = [73, 19];
  const { context } = sourceRuntime(scratch, { processIdentity() { calls++; return pair; } });
  pair[0] = 91;
  expect(runInContext("[process.pid, process.ppid]", context)).toEqual([73, 19]);
  expect(calls).toBe(1);
  expect(runInContext('Object.getOwnPropertyDescriptor(process, "pid")', context))
    .toEqual({ value: 73, writable: true, enumerable: true, configurable: true });
  runInContext("process.pid = 83", context);
  expect(runInContext("process.pid", context)).toBe(83);
  expect(calls).toBe(1);
});

test("an identity bridge error aborts process construction without a constant fallback", () => {
  expect(() => sourceRuntime(scratch, { processIdentity() { throw new Error("invalid admitted pair"); } }))
    .toThrow("invalid admitted pair");
});

test("public self-signal uses only its current execution binding even when another member has the same process PID", () => {
  const signals: [number, number][] = [];
  const other: [number, number][] = [];
  const identity = (): [number, number] => [73, 19];
  const member = sourceRuntime(scratch, { processIdentity: identity, hostSignal(signal, mode) { signals.push([signal, mode]); return 0; } });
  sourceRuntime(scratch, { processIdentity: identity, hostSignal(signal, mode) { other.push([signal, mode]); return 0; } });
  signals.length = 0;
  other.length = 0;
  expect(runInContext("process.kill(process.pid, 0)", member.context)).toBe(true);
  expect(signals).toEqual([]);
  expect(runInContext("process.kill(process.pid, 15)", member.context)).toBe(true);
  expect(signals).toEqual([[15, 3]]);
  expect(other).toEqual([]);
  expect(() => runInContext("process.kill(91, 0)", member.context)).toThrow();
});
