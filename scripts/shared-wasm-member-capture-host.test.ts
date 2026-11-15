import { expect, test } from "bun:test";
import { CaptureWriter, captureBytes, captureExecutor, captureImports, readCapture } from "../web/tests/shared-wasm-agent/capture";

function setup() {
  const buffer = new SharedArrayBuffer(captureBytes);
  return { buffer, capture: new CaptureWriter(buffer) };
}
function value(buffer: SharedArrayBuffer) {
  const snapshot = readCapture(buffer);
  if (snapshot.state !== "read") throw new Error(`Capture was ${snapshot.state}`);
  return snapshot.value;
}

test("capture preserves the exact thrown value, records its stack and never invokes it twice", () => {
  const { buffer, capture } = setup();
  const original = new WebAssembly.RuntimeError("host trap control");
  let calls = 0;
  expect(() => capture.run("host.control", () => { calls++; throw original; })).toThrow(original);
  expect(calls).toBe(1);
  expect(value(buffer).failures[0]?.stack).toContain("RuntimeError: host trap control");
  expect(value(buffer).depth).toBe(0);
  const cleanup = captureExecutor({ run: () => 0, beforeFinish() { throw original; } }, capture);
  try { cleanup.beforeFinish?.(); throw new Error("Cleanup did not throw"); }
  catch (error) { expect(error).toBe(original); }
  expect(value(buffer).phase).toBe("cleanup-entered");
});

test("stderr capture records only bytes accepted by the original write and preserves errno and throws", () => {
  const { buffer, capture } = setup();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const view = new DataView(memory.buffer);
  const text = new TextEncoder().encode("buffered stderr");
  new Uint8Array(memory.buffer, 32, text.length).set(text);
  view.setUint32(0, 32, true); view.setUint32(4, text.length, true);
  let result = 0, calls = 0;
  const original = new RangeError("write control");
  const imports = { env: { memory }, wasi_snapshot_preview1: { fd_write: (_fd: number, _iovs: number, _count: number, written: number) => {
    calls++;
    if (result === 99) throw original;
    view.setUint32(written, 3, true);
    return result;
  } } };
  captureImports(imports, capture);
  expect(imports.wasi_snapshot_preview1.fd_write(2, 0, 1, 16)).toBe(0);
  expect(value(buffer).stderr).toBe("buf");
  result = 6;
  expect(imports.wasi_snapshot_preview1.fd_write(2, 0, 1, 16)).toBe(6);
  expect(value(buffer).stderr).toBe("buf");
  result = 99;
  try { imports.wasi_snapshot_preview1.fd_write(2, 0, 1, 16); throw new Error("Write did not throw"); }
  catch (error) { expect(error).toBe(original); }
  expect(calls).toBe(3);
  expect(value(buffer).failures[0]).toMatchObject({ boundary: "wasi.fd_write", stack: expect.stringContaining("RangeError: write control") });
});

test("observation failures are counted without replacing execution and snapshots stay bounded", () => {
  const { buffer, capture } = setup();
  capture.observe(() => { throw new Error("observer control"); });
  expect(value(buffer).observationErrors).toBe(1);
  for (let index = 0; index < 12; index++) capture.error(new Error("🙂".repeat(10_000)));
  capture.stderr("🙂".repeat(10_000), true);
  expect(value(buffer).failures.length).toBe(4);
  expect(value(buffer).stderr.length).toBe(2048);
  expect(value(buffer).observationErrors).toBe(1);
  Atomics.add(new Int32Array(buffer), 0, 1);
  expect(readCapture(buffer)).toEqual({ state: "writing" });
});
