import { expect, test } from "bun:test";
import { networkFixture } from "./node-net-fixture";

async function rejectedHost(fixture: ReturnType<typeof networkFixture>, hostname: string) {
  const socket = fixture.own(new fixture.net.Socket());
  let error: Error | undefined;
  socket.on("error", value => { error = value; });
  socket.connect(80, hostname);
  expect(error).toBeUndefined();
  await fixture.pump();
  expect(error).toMatchObject({ name: "Error", code: "ENOTFOUND", syscall: "getaddrinfo", hostname, message: `getaddrinfo ENOTFOUND ${hostname}` });
}

test("invalid socket hostnames report resolver errors without opening a connection", async () => {
  const fixture = networkFixture();
  try {
    for (const hostname of ["this is not a hostname", "localhost:80", "a..b", "[127.0.0.1]", "[]", "::1/64", "a".repeat(64) + ".com"]) {
      await rejectedHost(fixture, hostname);
    }
  } finally { await fixture.dispose(); }
});

test("node:net preserves brackets for both connect and listen resolution", async () => {
  const fixture = networkFixture();
  try {
    await rejectedHost(fixture, "[::1]");
    const server = fixture.own(fixture.net.createServer());
    let failure: Error | undefined;
    server.on("error", value => { failure = value; });
    server.listen(0, "[::1]");
    expect(failure).toBeUndefined();
    await fixture.pump();
    expect(failure).toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "[::1]" });
    expect(server.listening).toBe(false);
  } finally { await fixture.dispose(); }
});

test("connect rejects non-string hosts synchronously", async () => {
  const fixture = networkFixture();
  try {
    for (const host of [123, true, {}, []]) {
      const socket = fixture.own(new fixture.net.Socket());
      expect(() => Reflect.apply(socket.connect, socket, [{ port: 80, host }])).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    }
  } finally { await fixture.dispose(); }
});
