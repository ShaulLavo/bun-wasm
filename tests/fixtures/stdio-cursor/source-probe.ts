import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { WriteStream } from "node:tty";
import { cursorBytes, emitCursorSequence, verifyDelegation, verifyNoop } from "./contract.ts";
import type { CursorWriter } from "./contract.ts";

const root = new URL("../../../", import.meta.url);
const path = "crates/bunwasm-runtime/src/js/process.js";
const before = process.argv.includes("--before");
const source = before
  ? execFileSync("git", ["show", `9d88564b:${path}`], { cwd: root, encoding: "utf8" })
  : readFileSync(new URL(path, root), "utf8");

function runtime(tty: boolean) {
  const output: [number, string, boolean][] = [];
  let failure: Error | null = null;
  function write(fd: number, chunk: string, flush: boolean) {
    if (failure) throw failure;
    output.push([fd, chunk, flush]);
  }
  const internal = {
    native: {
      platformInfo: {}, env: () => ({}), argv: () => [], execPath: () => "/bin/bun",
      hostSignal: () => 0, isatty: () => tty,
      writeStdout: (chunk: string, flush: boolean) => write(1, chunk, flush),
      writeStderr: (chunk: string, flush: boolean) => write(2, chunk, flush),
    },
    nextTick: process.nextTick,
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "process_signals") return () => () => false;
      throw new Error(`Unexpected dependency ${name}`);
    },
  };
  const guest = runInNewContext(source)(internal);
  return { guest, output, fail(error: Error | null) { failure = error; } };
}

async function failedWrites(stream: CursorWriter & EventEmitter & { writable: boolean }, state: ReturnType<typeof runtime>) {
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
  const order: string[] = [];
  const received: (Error | null | undefined)[] = [];
  const onError = (caught: Error) => { received.push(caught); order.push("event"); };
  stream.on("error", onError);
  state.fail(error);
  const callback = (caught?: Error | null) => {
    received.push(caught);
    order.push("callback");
    process.nextTick(() => order.push("callback tick"));
  };
  try {
    assert.equal(stream.clearLine(0, callback), false);
    assert.equal(stream.cursorTo(0, callback), false);
    assert.equal(stream.moveCursor(1, 1, callback), false);
    assert.equal(stream.clearScreenDown(callback), false);
    assert.equal(stream.write("ordinary pipe write", callback), false);
    assert.deepEqual(order, []);
    assert.equal(stream.writable, false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, Array<string>(5).fill("callback").concat(Array<string>(5).fill("callback tick"), ["event"]));
    assert.equal(stream.writable, true);
    assert.equal(received.length, 6);
    assert.ok(received.every(caught => caught === error));
  } finally { state.fail(null); stream.removeListener("error", onError); }
  assert.equal(stream.write("recovered"), true);
}

async function checkGuest(tty: boolean) {
  const state = runtime(tty);
  if (before) {
    assert.throws(() => state.guest.stdout.clearLine(0), /clearLine is not a function/);
    console.log(`before tty=${tty}: reproduced clearLine is not a function`);
    return;
  }
  for (const stream of [state.guest.stdout, state.guest.stderr]) {
    assert.equal(stream.isTTY, tty);
    verifyDelegation(stream);
    await verifyNoop(stream);
    await emitCursorSequence(stream);
  }
  assert.equal(state.output.filter(([fd]) => fd === 1).map(([, bytes]) => bytes).join(""), cursorBytes);
  assert.equal(state.output.filter(([fd]) => fd === 2).map(([, bytes]) => bytes).join(""), cursorBytes);
  assert.ok(state.output.every(([, , flush]) => flush));
  for (const stream of [state.guest.stdout, state.guest.stderr]) {
    await failedWrites(stream, state);
    assert.throws(() => stream.cursorTo(NaN), { code: "ERR_INVALID_ARG_VALUE" });
    assert.throws(() => stream.cursorTo(0, NaN), { code: "ERR_INVALID_ARG_VALUE" });
    assert.throws(() => stream.cursorTo(undefined, 1), { code: "ERR_INVALID_CURSOR_POS" });
    assert.throws(() => stream.clearLine(0, null), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => stream.clearScreenDown(null), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => stream.cursorTo(0, 0, null), { code: "ERR_INVALID_ARG_TYPE" });
    assert.throws(() => stream.moveCursor(0, 0, null), { code: "ERR_INVALID_ARG_TYPE" });
  }
  console.log(`after tty=${tty}: both fds bytes=${JSON.stringify(cursorBytes)}, callbacks deferred, EPIPE batching/identity/order and ordinary pipe recovery pass`);
}

if (process.argv.includes("--node")) {
  assert.equal(process.version, "v26.7.0");
  assert.equal(process.stdout.isTTY, true);
  assert.equal(process.stderr.isTTY, true);
  for (const fd of [1, 2]) {
    const stream = new WriteStream(fd);
    verifyDelegation(stream);
    await verifyNoop(stream);
    await emitCursorSequence(stream);
    stream.write("\n");
  }
  console.log("Node 26.7.0 real tty.WriteStream bytes/return/callback contract passes");
} else {
  await checkGuest(true);
  await checkGuest(false);
}
