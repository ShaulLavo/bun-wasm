import type { WorkerExecutor, WorkerSetupContext } from "waffle/browser/worker";
import type { RunRequest } from "../../src/bun-executor";

export const captureBytes = 65536;
const tailBytes = 2048;
type Fact = { boundary: string; stack: string };
export interface MemberCapture {
  phase: string;
  active: Fact[];
  depth: number;
  last: Fact | null;
  failures: Fact[];
  stderr: string;
  attemptedStderr: string;
  writes: number;
  observationErrors: number;
}
export type CapturedRequest = RunRequest & { sharedWasmCapture?: SharedArrayBuffer };

function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`).slice(0, 1000) : `Thrown ${typeof error}`;
}

/** One worker writes; the page reads without asking the blocked worker to execute. */
export class CaptureWriter {
  private readonly header: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly encoder = new TextEncoder();
  private readonly value: MemberCapture = { phase: "received", active: [], depth: 0, last: null, failures: [], stderr: "", attemptedStderr: "", writes: 0, observationErrors: 0 };

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer, 16);
    this.publish();
  }
  private publish() {
    const encoded = this.encoder.encode(JSON.stringify({ ...this.value, active: this.value.active.slice(-4) }));
    if (encoded.length > this.bytes.length) throw new RangeError("Member capture exceeded its fixed buffer");
    Atomics.add(this.header, 0, 1);
    this.bytes.set(encoded);
    Atomics.store(this.header, 1, encoded.length);
    Atomics.add(this.header, 0, 1);
  }
  observe(action: () => void) {
    try { action(); this.publish(); }
    catch { Atomics.add(this.header, 2, 1); }
  }
  phase(phase: string) { this.observe(() => { this.value.phase = phase; }); }
  run<T>(boundary: string, action: () => T): T {
    let entered = false;
    this.observe(() => {
      const fact = { boundary, stack: new Error(`Entered ${boundary}`).stack?.slice(0, 900) ?? "Host stack unavailable" };
      this.value.depth++; this.value.active.push(fact); this.value.last = fact; entered = true;
    });
    try { return action(); }
    catch (error) {
      this.observe(() => { this.value.failures = this.value.failures.slice(-3).concat([{ boundary, stack: errorStack(error) }]); });
      throw error;
    } finally { if (entered) this.leave(); }
  }
  private leave() { this.observe(() => { this.value.depth--; this.value.active.pop(); }); }
  stderr(text: string, accepted: boolean) {
    this.observe(() => {
      if (accepted) { this.value.stderr = (this.value.stderr + text).slice(-tailBytes); this.value.writes++; }
      else this.value.attemptedStderr = (this.value.attemptedStderr + text).slice(-tailBytes);
    });
  }
  error(error: unknown) { this.observe(() => { this.value.failures = this.value.failures.slice(-3).concat([{ boundary: this.value.phase, stack: errorStack(error) }]); }); }
}

export function readCapture(buffer: SharedArrayBuffer): { state: "empty" | "writing" } | { state: "read"; value: MemberCapture } {
  const header = new Int32Array(buffer, 0, 4);
  const before = Atomics.load(header, 0);
  if (before % 2) return { state: "writing" };
  const length = Atomics.load(header, 1);
  if (!length) return { state: "empty" };
  const bytes = new Uint8Array(buffer, 16, length).slice();
  if (before !== Atomics.load(header, 0)) return { state: "writing" };
  const value: MemberCapture = JSON.parse(new TextDecoder().decode(bytes));
  return { state: "read", value: { ...value, observationErrors: Atomics.load(header, 2) } };
}

function stderrText(memory: WebAssembly.Memory, iovs: number, count: number, accepted = Infinity): string {
  const view = new DataView(memory.buffer);
  let text = "";
  for (let index = 0; index < count && accepted > 0; index++) {
    const pointer = view.getUint32(iovs + index * 8, true);
    const length = Math.min(view.getUint32(iovs + index * 8 + 4, true), accepted);
    const bytes = new Uint8Array(memory.buffer, pointer + Math.max(0, length - tailBytes), Math.min(length, tailBytes)).slice();
    text = (text + new TextDecoder().decode(bytes)).slice(-tailBytes);
    accepted -= length;
  }
  return text;
}

function observePostedStderr(data: Uint8Array, capture: CaptureWriter, accepted: boolean): void {
  capture.observe(() => capture.stderr(new TextDecoder().decode(data.slice()), accepted));
}

function capturedPost(post: WorkerSetupContext["post"], capture: CaptureWriter): WorkerSetupContext["post"] {
  return (type, data) => {
    if (type !== "stderr") return post(type, data);
    observePostedStderr(data, capture, false);
    const accepted = capture.run("host.stderr", () => post(type, data));
    if (accepted) observePostedStderr(data, capture, true);
    return accepted;
  };
}

export function captureImports(imports: WebAssembly.Imports, capture: CaptureWriter): void {
  const memory = imports.env?.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Group capture requires the imported memory");
  const wasi = imports.wasi_snapshot_preview1;
  const write = wasi?.fd_write;
  if (wasi && typeof write === "function") wasi.fd_write = capturedWrite(write, memory, capture);
  const nested = imports.runtime_nested;
  const request = nested?.request;
  if (nested && typeof request === "function") nested.request = capturedNested(request, memory, capture);
}

function acceptedStderr(memory: WebAssembly.Memory, iovs: number, count: number, written: number, capture: CaptureWriter): void {
  capture.observe(() => capture.stderr(stderrText(memory, iovs, count, new DataView(memory.buffer).getUint32(written, true)), true));
}

function writeStderr(write: CallableFunction, memory: WebAssembly.Memory, capture: CaptureWriter, iovs: number, count: number, written: number): unknown {
  const result: unknown = Reflect.apply(write, undefined, [2, iovs, count, written]);
  if (result === 0) acceptedStderr(memory, iovs, count, written, capture);
  return result;
}

function capturedWrite(write: CallableFunction, memory: WebAssembly.Memory, capture: CaptureWriter) {
  return (fd: number, iovs: number, count: number, written: number) => {
    if (fd !== 2) return Reflect.apply(write, undefined, [fd, iovs, count, written]);
    capture.observe(() => capture.stderr(stderrText(memory, iovs, count), false));
    return capture.run("wasi.fd_write", () => writeStderr(write, memory, capture, iovs, count, written));
  };
}

function capturedNested(request: CallableFunction, memory: WebAssembly.Memory, capture: CaptureWriter) {
  return (pointer: number, length: number, out: number) => {
    let operation = "unknown";
    capture.observe(() => {
      const text = new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length).slice());
      operation = (Object.keys(JSON.parse(text))[0] ?? "unknown").slice(0, 80);
    });
    return capture.run(`runtime_nested.${operation}`, () => Reflect.apply(request, undefined, [pointer, length, out]));
  };
}

/** Wrap only public executor/import boundaries. Never call a guest export for a diagnostic. */
export function captureExecutor(executor: WorkerExecutor<RunRequest>, capture: CaptureWriter): WorkerExecutor<RunRequest> {
  return {
    ...executor,
    namespaces(context) {
      return executor.namespaces?.({ ...context, post: capturedPost(context.post, capture) }) ?? {};
    },
    imports(imports, context) {
      const selected = executor.imports?.(imports, context) ?? imports;
      captureImports(selected, capture);
      capture.phase("imports-bound");
      return selected;
    },
    initialize(context) { capture.phase("initialize"); return capture.run("initialize", () => executor.initialize?.(context)); },
    run(context, exited) { capture.phase("run"); return capture.run("run", () => executor.run(context, exited)); },
    beforeFinish() {
      capture.phase("cleanup-entered");
      capture.run("beforeFinish", () => executor.beforeFinish?.());
      capture.phase("cleanup-returned");
    },
  };
}
