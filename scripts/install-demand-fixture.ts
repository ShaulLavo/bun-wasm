import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Trace } from "./install-download-fixture";

type State = {
  base: string;
  trace: Trace;
  timers: Set<ReturnType<typeof setTimeout>>;
  waiting: Map<string, ServerResponse>;
};

export async function demandFixture() {
  const trace: Trace = { requests: [], active: new Set(), peak: 0, missedBarrier: false };
  const state: State = { base: "", trace, timers: new Set(), waiting: new Map() };
  const dependencies = { "a-shared": "npm:real-old@1.0.0", "b-parent": "1.0.0", "c-parent": "1.0.0" };
  const server = createServer((request, response) => serve(state, request, response));
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  state.base = `http://127.0.0.1:${address.port}`;
  return { base: state.base, dependencies, trace, async close() {
    for (const timer of state.timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
  } };
}

function metadata(state: State, name: string): string {
  const dependencies = name === "b-parent" ? { "a-shared": "npm:real-new@1.0.0" } : {};
  if (name === "c-parent") Object.assign(dependencies, Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`item-${index}`, "1.0.0"])));
  return JSON.stringify({ name, versions: { "1.0.0": { name, version: "1.0.0", dependencies, dist: { tarball: `${state.base}/${name}.tgz` } } } });
}

function schedule(state: State, callback: () => void, ms: number) {
  state.timers.add(setTimeout(callback, ms));
}

function serve(state: State, request: IncomingMessage, response: ServerResponse) {
  const name = decodeURIComponent((request.url ?? "/").slice(1));
  state.trace.requests.push(name);
  state.trace.active.add(response);
  state.trace.peak = Math.max(state.trace.peak, state.trace.active.size);
  response.once("close", () => state.trace.active.delete(response));
  response.writeHead(200, { "content-type": "application/json" });
  if (name.startsWith("item-")) { state.waiting.set(name, response); return; }
  if (name !== "real-new") { response.end(metadata(state, name)); return; }
  for (const ms of [200, 500, 800, 1100, 1400]) schedule(state, () => response.write(" "), ms);
  schedule(state, () => finishDemand(state, response), 1650);
}

function finishDemand(state: State, response: ServerResponse) {
  response.end(metadata(state, "real-new"));
  schedule(state, () => releaseSiblings(state), 350);
}

function releaseSiblings(state: State) {
  for (const [name, sibling] of state.waiting) sibling.end(metadata(state, name));
}
