import { expect, test } from "bun:test";
import { NetHost } from "waffle/browser/net/host";
import { NetNamespace } from "waffle/browser/net/helper";
import { createRing } from "waffle/browser/net/ring";
import { NetHelper } from "../src/net/helper";
import { createCliPreview } from "../scripts/cli-preview";

async function preview(guestPort: number, body: string) {
  const ring = createRing();
  const helper = new NetHelper(ring, await NetNamespace.create());
  const host = new NetHost(ring, request => helper.handle(request));
  const listener = host.listen("127.0.0.1", guestPort);
  const server = createCliPreview(guestPort, helper);
  const connections = new Set<number>();
  const timer = setInterval(() => {
    const accepted = host.accept(listener);
    if (accepted >= 0) connections.add(accepted);
    for (const handle of connections) {
      const bytes = host.read(handle, 65536);
      if (!(bytes instanceof Uint8Array)) continue;
      const target = new TextDecoder().decode(bytes).split(" ")[1];
      const reply = body + " " + target;
      host.write(handle, new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Length: ${reply.length}\r\n\r\n${reply}`));
      host.shutdown(handle);
    }
  }, 1);
  return { server, async dispose() {
    clearInterval(timer);
    await server.stop(true);
    for (const handle of connections) host.close(handle);
    host.close(listener);
    helper.dispose();
  } };
}

test("independent CLI helpers isolate the same virtual port from a real listener", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const occupiedPort = occupied.port;
  if (occupiedPort === undefined) throw new Error("TCP listener has no port");
  const owners: Awaited<ReturnType<typeof preview>>[] = [];
  try {
    const first = await preview(occupiedPort, "first"); owners.push(first);
    const second = await preview(occupiedPort, "second"); owners.push(second);
    expect(first.server.port).not.toBe(occupied.port);
    expect(second.server.port).not.toBe(occupied.port);
    expect(first.server.port).not.toBe(second.server.port);
    expect(await (await fetch(new URL("/first?x=1", first.server.url))).text()).toBe("first /first?x=1");
    expect(await (await fetch(new URL("/second", second.server.url))).text()).toBe("second /second");
    expect(await (await fetch(occupied.url)).text()).toBe("occupied");
  } finally {
    for (const owner of owners) await owner.dispose();
    await occupied.stop(true);
  }
  for (const owner of owners) {
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: owner.server.port, fetch: () => new Response("released") });
    try { expect(await (await fetch(rebound.url)).text()).toBe("released"); }
    finally { await rebound.stop(true); }
  }
});
