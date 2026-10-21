import { expect, test } from "bun:test";
import { load, service } from "./spawn-runtime-proc-fixture";

test("fork creates its implicit JSON IPC channel before the child starts", async () => {
  const fake = service();
  const { module, pump } = load(fake);
  const child = module.nodeChildProcess().fork("child.ts");
  expect(child.connected).toBe(true);
  expect(typeof child.send).toBe("function");
  const request = fake.children.get(child.pid)!.request;
  expect(JSON.parse(request.env.BUNWASM_IPC_CHANNEL)).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  child.kill("SIGKILL");
  await pump();
  expect(fake.open()).toBe(0);
});

function setup() {
  const fake = service();
  const loaded = load(fake);
  const child = loaded.module.nodeChildProcess().fork("child.ts", [], { silent: true });
  const record = fake.children.get(child.pid)!;
  const descriptors = JSON.parse(record.request.env.BUNWASM_IPC_CHANNEL);
  return { fake, ...loaded, child, record, descriptors };
}

test("JSON frames, asynchronous send callbacks and messages use separate child descriptors", async () => {
  const { fake, pump, pumpTurn, child, record, descriptors } = setup();
  let callback = false;
  const messages: unknown[] = [];
  child.on("message", (message: unknown) => messages.push(message));
  child.send({ dynamic: ["界", 17, null] }, (error: unknown) => { expect(error).toBeNull(); callback = true; });
  expect(callback).toBe(false);
  expect(fake.childRead(record, descriptors.input)).toBe('{"dynamic":["界",17,null]}\n');
  fake.childWrite(record, descriptors.output, '{"reply":73}\n{"reply":74}\n');
  pumpTurn();
  await Promise.resolve();
  expect(callback).toBe(true);
  expect(messages).toEqual([{ reply: 73 }, { reply: 74 }]);
  fake.exit(record, 0);
  await pump();
  expect(child.connected).toBe(false);
  expect(fake.open()).toBe(0);
});

test("partial and blocked writes preserve message/callback order through disconnect", async () => {
  const { fake, pump, pumpTurn, child, record, descriptors } = setup();
  const write = fake.native.procWrite;
  const callbacks: number[] = [];
  let writable = false;
  fake.native.procWrite = (fd: number, bytes: Uint8Array) => writable ? write(fd, bytes.subarray(0, 3)) : -6;
  const large = "x".repeat(130 * 1024);
  expect(child.send({ large }, () => callbacks.push(1))).toBe(false);
  child.send({ last: 2 }, () => callbacks.push(2));
  child.disconnect();
  expect(child.connected).toBe(false);
  expect(callbacks).toEqual([]);
  writable = true;
  let partial = true;
  fake.native.procWrite = (fd: number, bytes: Uint8Array) => {
    const count = write(fd, partial ? bytes.subarray(0, 3) : bytes);
    partial = false;
    return count;
  };
  pumpTurn();
  await Promise.resolve();
  let frames = "";
  for (;;) {
    const chunk = fake.childRead(record, descriptors.input);
    if (chunk === null || chunk === "") break;
    frames += chunk;
  }
  expect(frames).toBe(JSON.stringify({ large }) + '\n{"last":2}\n');
  expect(fake.childRead(record, descriptors.input)).toBeNull();
  expect(callbacks).toEqual([1, 2]);
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
});

test("child exit drains messages and fails pending sends once without leaking descriptors", async () => {
  const { fake, pump, child, record, descriptors } = setup();
  const errors: unknown[] = [];
  const messages: unknown[] = [];
  let disconnected = 0;
  child.on("disconnect", () => disconnected++);
  child.on("message", (value: unknown) => messages.push(value));
  fake.native.procWrite = () => -6;
  child.send({ queued: true }, (error: unknown) => errors.push(error));
  fake.childWrite(record, descriptors.output, '{"beforeExit":true}\n');
  fake.exit(record, 0);
  await pump();
  expect(messages).toEqual([{ beforeExit: true }]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
  expect(disconnected).toBe(1);
  expect(child.connected).toBe(false);
  expect(fake.open()).toBe(0);
});

test("exited child drains every separate frame through EOF before terminal events", async () => {
  const { fake, pump, child, record, descriptors } = setup();
  const messages: number[] = [];
  const callbacks: number[] = [];
  const terminalCounts: number[] = [];
  const inputPipe = record.held.get(descriptors.output)!.pipe;
  const outputPipe = record.held.get(descriptors.input)!.pipe;
  const parentInput = Array.from(fake.pipes).find(([, entry]) => entry.pipe === inputPipe && !entry.write)![0];
  const parentOutput = Array.from(fake.pipes).find(([, entry]) => entry.pipe === outputPipe && entry.write)![0];
  const reads = fake.native.procRead;
  const closes = fake.native.procClose;
  const closedDescriptors: number[] = [];
  let eof = 0;
  fake.native.procRead = (fd: number) => {
    const bytes = reads(fd);
    if (fd === parentInput && bytes === 0) eof++;
    return bytes;
  };
  fake.native.procClose = (fd: number) => { closedDescriptors.push(fd); return closes(fd); };
  fake.native.procWrite = () => -6;
  child.on("message", (message: { index: number }) => messages.push(message.index));
  child.on("disconnect", () => terminalCounts.push(messages.length));
  child.on("exit", () => terminalCounts.push(messages.length));
  const closed = new Promise<void>(resolve => child.once("close", () => { terminalCounts.push(messages.length); resolve(); }));
  for (let index = 0; index < 3; index++) child.send({ pending: index }, (error: unknown) => {
    expect(error).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
    callbacks.push(index);
  });
  for (let index = 0; index < 257; index++) fake.childWrite(record, descriptors.output, JSON.stringify({ index }) + "\n");
  fake.exit(record, 0);
  await pump();
  await closed;
  expect(messages).toEqual(Array.from({ length: 257 }, (_, index) => index));
  expect(terminalCounts).toEqual([257, 257, 257]);
  expect(callbacks).toEqual([0, 1, 2]);
  expect(eof).toBe(1);
  expect(closedDescriptors.filter(fd => fd === parentInput)).toHaveLength(1);
  expect(closedDescriptors.filter(fd => fd === parentOutput)).toHaveLength(1);
  expect(child.connected).toBe(false);
  expect(fake.open()).toBe(0);
});

test("live child reads remain fair before the unlimited terminal drain", async () => {
  const { fake, pump, pumpTurn, child, record, descriptors } = setup();
  const messages: number[] = [];
  child.on("message", (message: { index: number }) => messages.push(message.index));
  for (let index = 0; index < 129; index++) fake.childWrite(record, descriptors.output, JSON.stringify({ index }) + "\n");
  pumpTurn();
  await Promise.resolve();
  expect(messages).toEqual(Array.from({ length: 32 }, (_, index) => index));
  expect(child.connected).toBe(true);
  fake.exit(record, 0);
  await pump();
  expect(messages).toEqual(Array.from({ length: 129 }, (_, index) => index));
  expect(fake.open()).toBe(0);
});

test("closed send reports callback or error asynchronously, never both", async () => {
  const { fake, pump, child, record } = setup();
  child.disconnect();
  const emitted: unknown[] = [];
  child.on("error", (error: unknown) => emitted.push(error));
  let called = 0;
  expect(child.send("late", (error: unknown) => { called++; expect(error).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" }); })).toBe(false);
  expect(called).toBe(0);
  await Promise.resolve();
  expect(called).toBe(1);
  expect(emitted).toEqual([]);
  expect(child.send("late")).toBe(false);
  await Promise.resolve();
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
});

test("serialization rejects advanced mode, handles and invalid JSON before writing", async () => {
  const { fake, pump, child, record, descriptors, module } = setup();
  expect(() => module.nodeChildProcess().fork("child.ts", [], { serialization: "advanced" })).toThrow(/Advanced/);
  expect(() => child.send({ a: 1 }, {})).toThrow(/handle passing/);
  expect(() => child.send(undefined)).toThrow(/IPC message/);
  expect(() => child.send({ bigint: 1n })).toThrow();
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  expect(() => child.send(cycle)).toThrow();
  expect(fake.childRead(record, descriptors.input)).toBe("");
  expect(fake.children.size).toBe(1);
  child.disconnect();
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
});

test("serialization reentrancy cannot enqueue bytes after disconnect", async () => {
  const { fake, pump, child, record } = setup();
  let error: unknown;
  expect(child.send({ toJSON() { child.disconnect(); return {}; } }, (value: unknown) => error = value)).toBe(false);
  await Promise.resolve();
  expect(error).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
});

test("child listener-held liveness follows actual message/disconnect listener counts", async () => {
  const { EventEmitter } = await import("node:events");
  const fake = service();
  const { ipc, waiters, pump } = load(fake);
  const input = fake.native.procPipe();
  const output = fake.native.procPipe();
  const target = new EventEmitter();
  const channel = ipc.open(target, { input: input[0], output: output[1] }, true);
  expect(waiters[0].ref).toBe(false);
  const listener = () => {};
  target.on("message", listener);
  expect(waiters[0].ref).toBe(true);
  target.removeListener("message", listener);
  expect(waiters[0].ref).toBe(false);
  target.once("disconnect", listener);
  expect(waiters[0].ref).toBe(true);
  channel.unref();
  expect(waiters[0].ref).toBe(false);
  channel.ref();
  expect(waiters[0].ref).toBe(true);
  channel.close();
  fake.native.procClose(input[1]);
  fake.native.procClose(output[0]);
  await pump();
  expect(fake.open()).toBe(0);
});

test("incremental JSON decoder preserves split UTF8, and independent forks never share frames", async () => {
  const first = setup();
  const second = first.module.nodeChildProcess().fork("other.ts", [], { silent: true });
  const secondRecord = first.fake.children.get(second.pid)!;
  const secondFds = JSON.parse(secondRecord.request.env.BUNWASM_IPC_CHANNEL);
  const got: unknown[] = [];
  first.child.on("message", (value: unknown) => got.push([1, value]));
  second.on("message", (value: unknown) => got.push([2, value]));
  const bytes = new TextEncoder().encode('{"text":"界"}\n');
  const entry = first.record.held.get(first.descriptors.output)!;
  for (const byte of bytes) entry.pipe.chunks.push(new Uint8Array([byte]));
  first.fake.childWrite(secondRecord, secondFds.output, '{"text":"other"}\n');
  first.pumpTurn();
  await Promise.resolve();
  expect(got).toEqual([[1, { text: "界" }], [2, { text: "other" }]]);
  first.fake.exit(first.record, 0);
  first.fake.exit(secondRecord, 0);
  await first.pump();
  expect(first.fake.open()).toBe(0);
});

test("spawn admission failure closes every IPC end and emits only the spawn error", async () => {
  const fake = service({ failSpawn: -44 });
  const { module, waiters } = load(fake);
  const child = module.nodeChildProcess().fork("missing.ts", [], { silent: true });
  const error = await new Promise(resolve => child.once("error", resolve));
  expect(error).toMatchObject({ code: "ENOENT" });
  expect(child.connected).toBe(false);
  expect(waiters).toHaveLength(0);
  expect(fake.open()).toBe(0);
});

test("peer closed reader yields asynchronous EPIPE once and closes the channel", async () => {
  const { fake, pump, child, record, descriptors } = setup();
  fake.childClose(record, descriptors.input);
  const errors: unknown[] = [];
  child.on("error", (error: unknown) => errors.push(error));
  expect(child.send({ rejected: true })).toBe(false);
  expect(child.connected).toBe(false);
  expect(errors).toEqual([]);
  await Promise.resolve();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "EPIPE" });
  fake.exit(record, 0);
  await pump();
  expect(fake.open()).toBe(0);
});
