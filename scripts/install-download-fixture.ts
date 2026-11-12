import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { packageFixture } from "../tests/install/registry.mjs";

export type Trace = { requests: string[]; active: Set<ServerResponse>; peak: number; missedBarrier: boolean };

function metadata(name: string, base: string, dependencies: Record<string, string>, integrity: string | undefined, padding: boolean) {
  const manifest = { name, version: "1.0.0", dependencies, dist: { tarball: `${base}/archives/${name}`, integrity } };
  return JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest }, padding: padding ? "x".repeat(2 * 1024 * 1024) : "" });
}

export async function fixture(stage: "metadata" | "tarball" = "metadata", topology: "siblings" | "parents" = "siblings") {
  const trace: Trace = { requests: [], active: new Set(), peak: 0, missedBarrier: false };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const held = new Map<string, () => void>();
  const dependencies = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`item-${String(i).padStart(2, "0")}`, "1.0.0"]));
  const archives = new Map<string, ReturnType<typeof packageFixture>>();
  for (const name of Object.keys(dependencies)) {
    archives.set(name, packageFixture(name, "1.0.0", {}, name === "item-01" ? `module.exports = ${JSON.stringify(pressurePayload())};` : undefined));
  }
  let base = "";
  const state = { base, trace, timers, held, dependencies, archives, stage };
  const roots = topology === "parents" ? Object.fromEntries(Object.keys(dependencies).map(name => [name.replace("item-", "parent-"), "1.0.0"])) : dependencies;
  const server = createServer((request, response) => serveDownload(state, request, response));
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  state.base = base;
  return { base, trace, dependencies: roots, async close() {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
  } };
}

type State = {
  base: string;
  trace: Trace;
  timers: Set<ReturnType<typeof setTimeout>>;
  held: Map<string, () => void>;
  dependencies: Record<string, string>;
  archives: Map<string, ReturnType<typeof packageFixture>>;
  stage: "metadata" | "tarball";
};

function serveDownload(state: State, request: IncomingMessage, response: ServerResponse) {
  const { trace, timers, held, dependencies, archives, stage } = state;
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    response.end();
    return;
  }

  const path = decodeURIComponent(new URL(request.url ?? "/", "http://fixture.invalid").pathname.slice(1));
  const archive = path.startsWith("archives/");
  const name = archive ? path.slice("archives/".length) : path;
  const gated = archive === (stage === "tarball");
  trace.requests.push(path);
  trace.active.add(response);
  trace.peak = Math.max(trace.peak, trace.active.size);
  response.once("close", () => trace.active.delete(response));
  const finish = () => {
    response.writeHead(gated && name === "a-fail" ? 503 : 200, { "content-type": archive ? "application/octet-stream" : "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "cross-origin-resource-policy": "cross-origin" });
    if (archive) { response.end(archives.get(name)?.archive); return; }
    const children = name.startsWith("parent-") ? { [name.replace("parent-", "item-")]: "1.0.0" } : {};
    response.end(metadata(name, state.base, name === "parent" ? dependencies : children, archives.get(name)?.integrity, gated && name === "item-01"));
  };
  if (gated && name === "b-stall") return;
  if (gated && name === "item-01") timers.add(setTimeout(() => held.get("item-00")?.(), 80));
  if (!gated || name !== "item-00") {
    timers.add(setTimeout(finish, 40));
    return;
  }
  let released = false;
  held.set(name, () => {
    if (released) return;
    released = true;
    finish();
  });
  timers.add(setTimeout(() => {
    if (released) return;
    trace.missedBarrier = true;
    held.get(name)?.();
  }, 1000));
}

function pressurePayload(): string {
  const bytes = Buffer.alloc(1536 * 1024);
  let value = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    bytes[i] = value & 255;
  }
  return bytes.toString("base64");
}

export async function assertClosed(trace: Trace): Promise<void> {
  const deadline = performance.now() + 2000;
  while (trace.active.size && performance.now() < deadline) await new Promise(accept => setTimeout(accept, 10));
  assert.equal(trace.active.size, 0, "failed resolution left HTTP requests open");
}
