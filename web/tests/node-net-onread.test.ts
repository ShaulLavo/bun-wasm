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

test("callback false stops reads until resume without losing the next buffer", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => { own(peer).end("abcdef"); })).listen(0, "127.0.0.1");
    const chunks: string[] = [];
    let allocations = 0;
    const client = own(net.connect({ port: fixture.port(server), host: "127.0.0.1",
      onread: { buffer: () => { allocations++; return Buffer.alloc(2); }, callback(count: number, bytes: Uint8Array) { chunks.push(Buffer.from(bytes).toString("utf8", 0, count)); return chunks.length !== 1; } },
    }));
    await pump();
    expect(chunks).toEqual(["ab"]);
    expect(client.isPaused()).toBe(true);
    expect(client.bytesRead).toBe(2);
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
