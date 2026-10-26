import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { cursorBytes, cursorCases, verifyDelegation, verifyNoop, verifyValidation, verifyCoercion } from "./fixtures/stdio-cursor-contract";
import type { Callback, CursorWriter } from "./fixtures/stdio-cursor-contract";

type Writer = CursorWriter & EventEmitter & { fd: number; writable: boolean; isTTY: boolean };
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stdio-cursor-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const output = join(scratch, "process.js");
const strip = Bun.spawnSync(["node", join(import.meta.dir, "transpile-runtime.ts"),
  new URL("../crates/bunwasm-runtime/src/js/process.ts", import.meta.url).pathname, output]);
assert.equal(strip.exitCode, 0, strip.stderr.toString());
const factory: (internal: object) => { stdout: Writer; stderr: Writer; env: Record<string, unknown> } = runInNewContext(readFileSync(output, "utf8"));

function runtime(tty: boolean) {
  const output: [number, string | Uint8Array, boolean | undefined][] = [];
  const state: { failure: Error | null; reads: number; ttyReads: number } = { failure: null, reads: 0, ttyReads: 0 };
  function write(fd: number, chunk: string | Uint8Array, flush?: boolean) {
    if (state.failure) throw state.failure;
    output.push([fd, chunk, flush]);
  }
  const internal = {
    native: {
      platformInfo: {}, env: () => ({}), argv: () => [], execArgv: () => [], execPath: () => "/bin/bun", hostSignal: () => 0,
      isatty() { state.ttyReads++; return tty; },
      readStdin() { state.reads++; return new Uint8Array(); },
      writeStdout: (chunk: string | Uint8Array, flush?: boolean) => write(1, chunk, flush),
      writeStderr: (chunk: string | Uint8Array, flush?: boolean) => write(2, chunk, flush),
    },
    nextTick: process.nextTick,
    describe(value: unknown) { assert.equal(value, null); return "null"; },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "process_signals") return () => () => false;
      throw new Error(`Unexpected dependency ${name}`);
    },
  };
  return { guest: factory(internal), output, state };
}

for (const tty of [true, false]) {
  test(`stdio cursor methods delegate bytes, callbacks and boolean results, tty=${tty}`, () => {
    const { guest } = runtime(tty);
    verifyDelegation(guest.stdout);
    verifyDelegation(guest.stderr);
  });

  test(`zero movement defers callbacks without writing, tty=${tty}`, async () => {
    const { guest } = runtime(tty);
    await verifyNoop(guest.stdout);
    await verifyNoop(guest.stderr);
  });

  test(`existing writers emit bytes with deferred success callbacks, tty=${tty}`, async () => {
    const { guest, output, state } = runtime(tty);
    expect(state.ttyReads).toBe(0);
    const order: string[] = [];
    for (const stream of [guest.stdout, guest.stderr]) {
      expect(stream.isTTY).toBe(tty);
      expect(stream).toBe(stream.fd === 1 ? guest.stdout : guest.stderr);
      emitCursorBytes(stream, order);
    }
    expect(state.ttyReads).toBe(2);
    expect(state.reads).toBe(0);
    expect(order).toEqual([]);
    await new Promise<void>(resolve => process.nextTick(resolve));
    expect(order).toHaveLength(cursorCases.length * 2);
    for (const fd of [1, 2]) {
      expect(output.filter(([written]) => written === fd).map(([, chunk]) => chunk).join("")).toBe(cursorBytes);
    }
    expect(output.every(([, , flush]) => flush === true)).toBe(true);
  });
}

function emitCursorBytes(stream: CursorWriter, order: string[]) {
  for (const entry of cursorCases) {
    expect(entry.call(stream, error => { assert.equal(error, null); order.push("callback"); })).toBe(true);
  }
}

test("Vite 7.1.12's cleanup runs with a TTY and no CI suppression", () => {
  const { guest, output } = runtime(true);
  expect(guest.stdout.isTTY).toBe(true);
  expect(guest.env.CI).toBeUndefined();
  runInNewContext(`if (process.stdout.isTTY && !process.env.CI) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }`, { process: guest });
  expect(output).toEqual([[1, "\x1b[2K", true], [1, "\x1b[1G", true]]);
});

test("borrowed cursor methods use the call receiver's write", () => {
  const { guest } = runtime(true);
  const writes: [unknown, unknown][] = [];
  const receiver = { write(chunk: unknown, callback: unknown) { assert.equal(this, receiver); writes.push([chunk, callback]); return false; } };
  const callback: Callback = () => { throw new Error("write owns callback"); };
  assert.equal(guest.stdout.clearLine.call(receiver, 0, callback), false);
  assert.equal(guest.stdout.cursorTo.call(receiver, 0, callback), false);
  assert.equal(guest.stdout.moveCursor.call(receiver, 1, -1, callback), false);
  assert.equal(guest.stdout.clearScreenDown.call(receiver, callback), false);
  expect(writes).toEqual([["\x1b[2K", callback], ["\x1b[1G", callback], ["\x1b[1C\x1b[1A", callback], ["\x1b[0J", callback]]);
});

for (const fd of [1, 2]) {
  test(`fd ${fd} cursor and ordinary write failures share the unchanged deferred error path`, async () => {
    const { guest, state, output } = runtime(true);
    const stream = fd === 1 ? guest.stdout : guest.stderr;
    const error = new Error("write EPIPE");
    state.failure = error;
    const order: string[] = [];
    stream.on("error", caught => { assert.equal(caught, error); order.push("error"); });
    const callback: Callback = caught => {
      assert.equal(caught, error);
      order.push("callback");
      process.nextTick(() => order.push("callback tick"));
    };
    expect(stream.clearLine(0, callback)).toBe(false);
    expect(stream.cursorTo(0, callback)).toBe(false);
    expect(stream.moveCursor(1, 1, callback)).toBe(false);
    expect(stream.clearScreenDown(callback)).toBe(false);
    expect(stream.write("ordinary", callback)).toBe(false);
    expect(stream.writable).toBe(false);
    expect(order).toEqual([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual(Array<string>(5).fill("callback").concat(Array<string>(5).fill("callback tick"), ["error"]));
    expect(stream.writable).toBe(true);
    state.failure = null;
    expect(stream.write("recovered")).toBe(true);
    expect(output).toEqual([[fd, "recovered", true]]);
  });
}

test("relative cursor coercion takes only the first matching axis branch", () => {
  const { guest } = runtime(true);
  verifyCoercion(guest.stdout);
  verifyCoercion(guest.stderr);
});

test("cursor argument errors occur before writes, including the overloaded callback", () => {
  const { guest, output } = runtime(true);
  verifyValidation(guest.stdout);
  verifyValidation(guest.stderr);
  expect(output).toEqual([]);
});

test("Node's real tty.WriteStream methods satisfy the same contract", () => {
  const reference = Bun.spawnSync(["node", join(import.meta.dir, "fixtures/stdio-cursor-contract.ts")], { timeout: 15_000 });
  expect(reference.stderr.toString()).toBe("");
  expect(reference.stdout.toString()).toContain("stdio cursor reference");
  expect(reference.exitCode).toBe(0);
});

test("cursor declarations accept overloads without weakening existing process contracts", () => {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  const root = new URL("../", import.meta.url).pathname;
  writeFileSync(config, JSON.stringify({ extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [], files: [
    join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/worker_protocol.d.ts"), probe,
  ] }));
  writeFileSync(probe, `declare const s: BunWasm.ProcessWriter;
    const callback: BunWasm.ProcessCursorCallback = error => { const raw: unknown = error; };
    const result: boolean = s.clearLine(0, callback);
    s.cursorTo(0); s.cursorTo(1, callback); s.cursorTo(1, 2, callback);
    s.cursorTo(undefined, undefined, callback); s.moveCursor(0, 0, callback); s.clearScreenDown(callback);
    s.write(new Uint8Array(), "utf8", callback); s.write("x", () => {});
    const same: BunWasm.ProcessWriter = s.end(); const fd: number = s.fd;
    const reader: BunWasm.ProcessReader | undefined = undefined;
    // @ts-expect-error Cursor columns are numeric.
    s.cursorTo("0");
    // @ts-expect-error Cursor callbacks are functions, not null.
    s.clearLine(0, null);
    // @ts-expect-error The existing fd declaration remains numeric.
    const text: string = s.fd;
  `);
  const result = Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
