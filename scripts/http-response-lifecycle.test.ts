import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fixture } from "./net-http-fixture";
import { exchanges, normalizeWire, observe, request, type Trace } from "../tests/fixtures/http-response-lifecycle/scenarios.ts";

// Real Node is the reference; the runtime side runs the actual net.js server over the modeled host ABI.
function nodeReference(): Record<string, unknown> {
  const script = fileURLToPath(new URL("../tests/fixtures/http-response-lifecycle/node-reference.ts", import.meta.url));
  const result = spawnSync("node", ["--no-warnings", script], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Node reference failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function runtimeResults(): Promise<Record<string, unknown>> {
  const state = fixture();
  const traces = new Map<string, Trace>();
  const clientErrors: string[] = [];
  const server = state.http.createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const path = (incoming.url ?? "/").slice(1);
    traces.set(path, observe(path, response));
  });
  server.on("clientError", (error: Error) => clientErrors.push(error.message));
  const results: Record<string, unknown> = {};
  for (const { name, paths, cancelAfter } of exchanges) {
    const writes = state.writes.length;
    const closes = state.closed.length;
    const wire = () => normalizeWire(Buffer.concat(state.writes.slice(writes)).toString("latin1"));
    const connection = state.socket();
    Reflect.get(server, "_onConnection").call(server, connection);
    for (const [index, path] of paths.entries()) {
      state.packets.push(Buffer.from(request(path, index === paths.length - 1)));
      await state.pump();
    }
    let end = state.closed.length > closes ? "server-closed" : "open";
    if (cancelAfter && wire().includes(cancelAfter)) {
      state.packets.push(-1);
      await state.pump();
      end = "client-cancelled";
    }
    results[name] = { client: { wire: wire(), end }, server: traces.get(name) ?? null };
    expect(Reflect.get(connection, "busy")).toBe(false);
  }
  results.clientErrors = clientErrors;
  expect(Reflect.get(server, "_connections").size).toBe(0);
  expect(state.pending()).toBe(0);
  return results;
}

test("HTTP response lifecycle matches the Node reference in every case", async () => {
  const reference = nodeReference();
  expect(await runtimeResults()).toEqual(reference);
});
