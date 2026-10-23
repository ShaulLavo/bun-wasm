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

test("a bracketed IPv6 loopback reaches the listener", async () => {
  const fixture = networkFixture();
  const { net, own, pump } = fixture;
  try {
    const server = own(net.createServer(peer => own(peer).end("IPv6"))).listen(0, "::1");
    const chunks: string[] = [];
    const client = own(net.connect(fixture.port(server), "[::1]"));
    client.on("data", chunk => chunks.push(chunk.toString()));
    await pump();
    expect(chunks.join("")).toBe("IPv6");
  } finally { await fixture.dispose(); }
});
