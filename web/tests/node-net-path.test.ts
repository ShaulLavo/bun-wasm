import { expect, test } from "bun:test";
import type { Socket } from "node:net";
import { unixNetworkFixture } from "./node-net-path-fixture";

test("Nuxt path listener accepts streamed bytes and write-half close preserves reverse traffic", async () => {
  const fixture = unixNetworkFixture();
  const { net, own, pump } = fixture;
  const chunks: string[] = [];
  let peer: Socket | undefined;
  let eof = false;
  try {
    const server = own(net.createServer({ allowHalfOpen: true }, socket => {
      peer = own(socket);
      socket.on("data", chunk => chunks.push(chunk.toString()));
      socket.on("end", () => { eof = true; socket.end("response"); });
    })).listen("/tmp/nuxt-vite.sock");
    const events: string[] = [];
    server.on("listening", () => events.push("listening"));
    await pump();
    expect(server.address()).toBe("/tmp/nuxt-vite.sock");
    const client = own(net.createConnection("/tmp/nuxt-vite.sock", () => events.push("connect")));
    let response = "";
    client.on("data", bytes => { response += bytes.toString(); });
    client.write("one");
    client.end("two");
    await pump();
    expect(events).toEqual(["listening", "connect"]);
    expect(chunks.join("")).toBe("onetwo");
    expect(eof).toBe(true);
    expect(response).toBe("response");
    expect(client.remoteAddress).toBeUndefined();
    expect(client.remotePort).toBeUndefined();
    expect(client.remoteFamily).toBeUndefined();
    expect(peer?.localPort).toBeUndefined();
    expect(peer?.localAddress).toBeUndefined();
    expect(peer?.address()).toEqual({});
    server.close();
    await pump();
    expect(fixture.paths.size).toBe(0);
  } finally { await fixture.dispose(); }
});

test("relative paths keep symlink-sensitive dots and use the current cwd", async () => {
  const fixture = unixNetworkFixture();
  try {
    const server = fixture.own(fixture.net.createServer(socket => fixture.own(socket).end())).listen({ path: "link/../nuxt.sock" });
    const client = fixture.own(fixture.net.connect({ path: "link/../nuxt.sock", port: 80, lookup() { throw new Error("Unix paths must not use DNS"); } }));
    client.resume();
    await fixture.pump();
    expect(fixture.calls).toEqual([["listen", "/work/project/link/../nuxt.sock", 1], ["connect", "/work/project/link/../nuxt.sock"]]);
    expect(server.address()).toBe("link/../nuxt.sock");
  } finally { await fixture.dispose(); }
});

test("a leading NUL names an abstract socket without a cwd join; other NULs still join and fail", async () => {
  const fixture = unixNetworkFixture();
  try {
    let received = "";
    const server = fixture.own(fixture.net.createServer({ allowHalfOpen: true }, socket => {
      fixture.own(socket).on("data", bytes => { received += bytes.toString(); });
      socket.on("end", () => socket.end(`echo:${received}`));
    })).listen("\0nuxt-x.sock");
    const client = fixture.own(fixture.net.createConnection("\0nuxt-x.sock"));
    let response = "";
    client.on("data", bytes => { response += bytes.toString(); });
    client.end("ping");
    await fixture.pump();
    await fixture.pump();
    expect(server.address()).toBe("\0nuxt-x.sock");
    expect(response).toBe("echo:ping");
    const relative = fixture.own(fixture.net.createServer());
    const errors: unknown[] = [];
    relative.on("error", error => errors.push(error));
    relative.listen("rel\0x");
    await fixture.pump();
    expect(errors).toMatchObject([{ code: "EINVAL", syscall: "listen", address: "rel\0x" }]);
    expect(fixture.calls).toEqual([["listen", "\0nuxt-x.sock", 1], ["connect", "\0nuxt-x.sock"], ["listen", "/work/project/rel\0x", 1]]);
  } finally { await fixture.dispose(); }
});

const failures: [string, string][] = [["/tmp/missing.sock", "ENOENT"], ["", "ENOENT"], ["\0abstract", "ECONNREFUSED"], ["/tmp/a\0suffix", "EINVAL"], ["rel\0x", "EINVAL"], ["/" + "é".repeat(2048), "ENAMETOOLONG"]];
for (const [path, code] of failures) {
  test(`path connect reports ${code} through error then close`, async () => {
    const fixture = unixNetworkFixture();
    try {
      const events: unknown[] = [];
      const socket = fixture.own(fixture.net.connect({ path }));
      socket.on("error", error => events.push(error));
      socket.on("close", hadError => events.push(["close", hadError]));
      expect(events).toEqual([]);
      await fixture.pump();
      expect(events[0]).toMatchObject({ code, syscall: "connect", address: path });
      expect(events[1]).toEqual(["close", true]);
    } finally { await fixture.dispose(); }
  });
}

test("duplicate listen errors asynchronously; closing a listener preserves accepted streams", async () => {
  const fixture = unixNetworkFixture();
  try {
    let accepted: Socket | undefined;
    const server = fixture.own(fixture.net.createServer(socket => { accepted = fixture.own(socket); })).listen({ path: "/tmp/shared.sock" });
    const client = fixture.own(fixture.net.connect({ path: "/tmp/shared.sock" }));
    client.resume();
    await fixture.pump();
    const duplicate = fixture.own(fixture.net.createServer());
    const errors: unknown[] = [];
    duplicate.on("error", error => errors.push(error));
    duplicate.listen({ path: "/tmp/shared.sock" });
    expect(errors).toEqual([]);
    await fixture.pump();
    expect(errors).toMatchObject([{ code: "EADDRINUSE", syscall: "listen", address: "/tmp/shared.sock" }]);
    let closed = 0;
    server.close(() => closed++);
    expect(fixture.paths.size).toBe(0);
    let received = "";
    client.on("data", bytes => { received += bytes.toString(); });
    accepted!.end("still connected");
    await fixture.pump();
    expect(received).toBe("still connected");
    expect(closed).toBe(1);
  } finally { await fixture.dispose(); }
});

test("HTTP listens on a filesystem path and requests use socketPath, keeping URL path separate", async () => {
  const fixture = unixNetworkFixture();
  try {
    const server = fixture.http.createServer((request, response) => response.end(`url=${request.url}`));
    server.listen("/tmp/vite-node.sock");
    await fixture.pump();
    expect(server.address()).toBe("/tmp/vite-node.sock");
    let body = "";
    const request = fixture.http.get({ socketPath: "/tmp/vite-node.sock", path: "/module?id=2", agent: false }, response => {
      response.on("data", bytes => { body += bytes.toString(); });
    });
    const errors: unknown[] = [];
    request.on("error", error => errors.push(error));
    try {
      await fixture.pump();
      expect(errors).toEqual([]);
      expect(body).toBe("url=/module?id=2");
      expect(fixture.calls).toEqual([["listen", "/tmp/vite-node.sock", 1], ["connect", "/tmp/vite-node.sock"]]);
    } finally { request.destroy(); server.closeAllConnections(); server.close(); }
  } finally { await fixture.dispose(); }
});

test("HTTP socketPath carries an abstract name unchanged", async () => {
  const fixture = unixNetworkFixture();
  try {
    const server = fixture.http.createServer((request, response) => response.end(`url=${request.url}`));
    server.listen("\0nuxt-vite-node");
    await fixture.pump();
    let body = "";
    const request = fixture.http.get({ socketPath: "\0nuxt-vite-node", path: "/module", agent: false }, response => {
      response.on("data", bytes => { body += bytes.toString(); });
    });
    try {
      await fixture.pump();
      expect(server.address()).toBe("\0nuxt-vite-node");
      expect(body).toBe("url=/module");
      expect(fixture.calls).toEqual([["listen", "\0nuxt-vite-node", 1], ["connect", "\0nuxt-vite-node"]]);
    } finally { request.destroy(); server.closeAllConnections(); server.close(); }
  } finally { await fixture.dispose(); }
});

test("path streams retain partial writes and drain once the receiver consumes them", async () => {
  const fixture = unixNetworkFixture();
  try {
    const chunks: Buffer[] = [];
    const server = fixture.own(fixture.net.createServer(socket => {
      fixture.own(socket).on("data", bytes => chunks.push(Buffer.from(bytes)));
    })).listen({ path: "/tmp/pressure.sock" });
    const client = fixture.own(fixture.net.connect({ path: "/tmp/pressure.sock" }));
    const payload = Buffer.alloc(2 * 1024 * 1024, 37);
    let callbacks = 0;
    let drains = 0;
    client.on("drain", () => drains++);
    expect(client.write(payload, () => callbacks++)).toBe(false);
    for (let turn = 0; turn < 8; turn++) await fixture.pump();
    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(callbacks).toBe(1);
    expect(drains).toBe(1);
    client.end();
    server.close();
  } finally { await fixture.dispose(); }
});

test("writing after a path peer closes exposes EPIPE and closes once", async () => {
  const fixture = unixNetworkFixture();
  try {
    let peer: Socket | undefined;
    fixture.own(fixture.net.createServer(socket => { peer = fixture.own(socket); })).listen({ path: "/tmp/closed.sock" });
    const client = fixture.own(fixture.net.connect({ path: "/tmp/closed.sock", allowHalfOpen: true }));
    const errors: unknown[] = [];
    let closes = 0;
    client.on("error", error => errors.push(error));
    client.on("close", () => closes++);
    await fixture.pump();
    peer!.destroy();
    await fixture.pump();
    client.write("late");
    await fixture.pump();
    expect(errors).toMatchObject([{ code: "EPIPE" }]);
    expect(closes).toBe(1);
  } finally { await fixture.dispose(); }
});

test("acknowledged unlink failure reaches close callback without keeping a listener alive", async () => {
  const fixture = unixNetworkFixture();
  try {
    const server = fixture.own(fixture.net.createServer()).listen({ path: "/tmp/unlink-error.sock" });
    await fixture.pump();
    fixture.failClose("EACCES");
    let error: unknown;
    let closes = 0;
    server.on("close", () => closes++);
    server.close(value => { error = value; });
    await fixture.pump();
    expect(error).toMatchObject({ code: "EACCES", syscall: "close", address: "/tmp/unlink-error.sock" });
    expect(server.listening).toBe(false);
    expect(closes).toBe(1);
    expect(fixture.paths.size).toBe(0);
  } finally { await fixture.dispose(); }
});
