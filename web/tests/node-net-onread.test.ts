import { expect, test } from "bun:test";
import { networkFixture } from "./node-net-fixture";

test("connect forwards onread and stream constructor options", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => { own(peer).end("hello"); })).listen(0, "127.0.0.1");
    const chunks: string[] = [], backing = Buffer.alloc(3);
    const client = own(net.connect(Object.assign({ port: fixture.port(server), host: "127.0.0.1",
      onread: { buffer: backing, callback(count: number, bytes: Uint8Array) { expect(bytes).toBe(backing); chunks.push(Buffer.from(bytes).toString("utf8", 0, count)); return true; } },
    }, { readableHighWaterMark: 17, writableHighWaterMark: 23 })));
    let streamData = false;
    client.on("data", () => { streamData = true; });
    await pump();
    expect(chunks).toEqual(["hel", "lo"]);
    expect(client.bytesRead).toBe(5);
    expect(streamData).toBe(false);
    expect(client.readableHighWaterMark).toBe(17);
    expect(client.writableHighWaterMark).toBe(23);
  } finally { await fixture.dispose(); }
});

test("callback false stops the handle without pausing; read(0) and resume restart it", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => { own(peer).end("abcdef"); })).listen(0, "127.0.0.1");
    const chunks: string[] = [];
    let allocations = 0;
    const client = own(net.connect({ port: fixture.port(server), host: "127.0.0.1",
      onread: { buffer: () => { allocations++; return Buffer.alloc(2); }, callback(count: number, bytes: Uint8Array) { chunks.push(Buffer.from(bytes).toString("utf8", 0, count)); return chunks.length > 2; } },
    }));
    let pauses = 0;
    client.on("pause", () => { pauses++; });
    await pump();
    expect(chunks).toEqual(["ab"]);
    expect(client.isPaused()).toBe(false);
    expect(pauses).toBe(0);
    expect(client.bytesRead).toBe(2);
    client.read(0);
    await pump();
    expect(chunks).toEqual(["ab", "cd"]);
    expect(client.isPaused()).toBe(false);
    expect(pauses).toBe(0);
    client.resume();
    await pump();
    expect(chunks).toEqual(["ab", "cd", "ef"]);
    expect(client.bytesRead).toBe(6);
    expect(allocations).toBe(4);
  } finally { await fixture.dispose(); }
});

test("a paused onread socket reconnects without early delivery or an old handle", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    let connections = 0;
    const server = own(net.createServer(peer => { own(peer); if (++connections === 2) peer.end("hello"); })).listen(0, "127.0.0.1");
    const options = { port: fixture.port(server), host: "127.0.0.1" };
    const chunks: string[] = [];
    const client = own(net.connect({ ...options, onread: { buffer: Buffer.alloc(64), callback(count: number, bytes: Uint8Array) { chunks.push(Buffer.from(bytes).toString("utf8", 0, count)); return true; } } }));
    await pump();
    client.unref();
    client.pause();
    client.connect(options);
    await pump();
    expect(connections).toBe(2);
    expect(fixture.closed.length).toBeGreaterThan(0);
    expect(chunks).toEqual([]);
    client.resume();
    await pump();
    expect(chunks).toEqual(["hello"]);
    expect(client.bytesRead).toBe(5);
  } finally { await fixture.dispose(); }
});

test("connect preserves a disabled readable or writable side", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => { own(peer); })).listen(0, "127.0.0.1");
    const options = { port: fixture.port(server), host: "127.0.0.1" };
    const writeOnly = own(net.connect({ ...options, readable: false }));
    const readOnly = own(net.connect({ ...options, writable: false, allowHalfOpen: true }));
    await pump();
    expect(writeOnly.readable).toBe(false);
    expect(readOnly.writable).toBe(false);
    expect(readOnly.allowHalfOpen).toBe(true);
  } finally { await fixture.dispose(); }
});


test("Socket accepts null constructor options", async () => {
  const fixture = networkFixture();
  try {
    const socket = fixture.own(Reflect.construct(fixture.net.Socket, [null]));
    expect(socket.readable).toBe(true);
    expect(socket.writable).toBe(true);
  } finally { await fixture.dispose(); }
});

test("an already-aborted connect signal closes once", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => { own(peer); })).listen(0, "127.0.0.1");
    const client = own(net.connect({ port: fixture.port(server), host: "127.0.0.1", signal: AbortSignal.abort() }));
    const errors: string[] = [];
    let closes = 0;
    client.on("error", error => { errors.push("code" in error ? String(error.code) : error.message); });
    client.on("close", () => { closes++; });
    await pump();
    expect(errors).toEqual(["ABORT_ERR"]);
    expect(closes).toBe(1);
  } finally { await fixture.dispose(); }
});

test.each([false, true])("Socket constructor owns its abort signal, pre-aborted=%s", async preAborted => {
  const fixture = networkFixture();
  try {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const socket = fixture.own(new fixture.net.Socket({ signal: controller.signal }));
    const errors: string[] = [];
    let closes = 0;
    socket.on("error", error => { errors.push("code" in error ? String(error.code) : error.message); });
    socket.on("close", () => { closes++; });
    controller.abort();
    await fixture.pump();
    expect(errors).toEqual(["ABORT_ERR"]);
    expect(closes).toBe(1);
  } finally { await fixture.dispose(); }
});
