import { afterEach, expect, test } from "bun:test";
import { Agent, request } from "node:http";
import { PreviewPortSockets, type SocketAliasOwner } from "../scripts/preview-port-sockets";

const releases: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.reverse()) await release(); releases.length = 0; });
async function pool() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  releases.push(() => probe.stop(true));
  const port = Number(probe.port);
  await probe.stop(true);
  return { port, aliases: new PreviewPortSockets() };
}
function owner(origin: string): SocketAliasOwner {
  return { ownsOrigin: source => source === origin, fetchPort: async () => new Response("owned"), upgradePort: async () => false };
}
function status(port: number, hostname: string, origin: string, agent?: Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${port}`, { agent: agent ?? false, headers: { host: `${hostname}:${port}`, origin } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.on("error", reject); outgoing.end();
  });
}

test("shared port listener retains exact hostname leases through independent and repeated cleanup", async () => {
  const { port, aliases } = await pool();
  const first = owner("http://bw-1.localhost:1"), second = owner("http://bw-2.localhost:2");
  releases.push(() => aliases.closeOwner(second), () => aliases.closeOwner(first));
  await aliases.reserve(port, first);
  await aliases.reserve(port, first, "bw-1.localhost");
  await aliases.reserve(port, first, "bw-3.localhost");
  await aliases.reserve(port, second);
  await aliases.reserve(port, second, "bw-2.localhost");
  expect(await status(port, "bw-1.localhost", "http://bw-1.localhost:1")).toBe(200);
  expect(await status(port, "bw-1.localhost", "http://bw-2.localhost:2")).toBe(403);
  expect(await status(port, "bw-4.localhost", "http://bw-1.localhost:1")).toBe(403);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  releases.push(() => agent.destroy());
  expect(await status(port, "bw-1.localhost", "http://bw-1.localhost:1", agent)).toBe(200);
  expect(await status(port, "bw-3.localhost", "http://bw-1.localhost:1", agent)).toBe(421);
  agent.destroy();
  await aliases.releaseHost("bw-1.localhost", first);
  await aliases.releaseHost("bw-1.localhost", first);
  expect(await status(port, "bw-1.localhost", "http://bw-1.localhost:1")).toBe(403);
  expect(await status(port, "bw-3.localhost", "http://bw-1.localhost:1")).toBe(200);
  await aliases.closeOwner(first);
  expect(await status(port, "bw-3.localhost", "http://bw-1.localhost:1")).toBe(403);
  expect(await status(port, "localhost", "http://bw-2.localhost:2")).toBe(200);
  await aliases.release(port, second);
  await aliases.closeOwner(second);
  await expect(status(port, "127.0.0.1", "http://bw-2.localhost:2")).rejects.toThrow();
});

test("shared port listener preserves the 512 host-port allocation bound and releases its slots", async () => {
  const { port, aliases } = await pool();
  const authority = owner("http://bw-0.localhost:1");
  releases.push(() => aliases.closeOwner(authority));
  for (let index = 0; index < 512; index++) await aliases.reserve(port, authority, `bw-${index}.localhost`);
  await aliases.reserve(port, authority, "bw-0.localhost");
  await expect(aliases.reserve(port, authority, "bw-512.localhost")).rejects.toThrow("alias limit");
  await aliases.releaseHost("bw-0.localhost", authority);
  await aliases.reserve(port, authority, "bw-512.localhost");
  await expect(aliases.reserve(port, authority, "example.test")).rejects.toThrow("loopback hostname");
  await aliases.closeOwner(authority);
  await aliases.reserve(port, authority);
  expect(await status(port, "127.0.0.1", "http://bw-0.localhost:1")).toBe(200);
});
