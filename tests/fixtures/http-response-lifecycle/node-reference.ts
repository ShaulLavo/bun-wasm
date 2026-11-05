import { createServer } from "node:http";
import { connect } from "node:net";
import { exchanges, normalizeWire, observe, request, type Trace } from "./scenarios.ts";

// Prints the Node reference result for every shared lifecycle exchange as JSON.
const traces = new Map<string, Trace>();
const closed = new Map<string, Promise<void>>();
const clientErrors: string[] = [];
const server = createServer((incoming, response) => {
  const path = (incoming.url ?? "/").slice(1);
  traces.set(path, observe(path, response));
  closed.set(path, new Promise(resolve => response.once("close", () => setImmediate(resolve))));
});
server.on("clientError", error => clientErrors.push(error.message));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a listening TCP address");
const port = address.port;

type ExchangeResult = { wire: string; end: string };

function exchangeSocket(paths: string[], cancelAfter: string | undefined, resolve: (result: ExchangeResult) => void): void {
  let bytes = "";
  let index = 0;
  const socket = connect({ host: "127.0.0.1", port });
  const send = () => socket.write(request(paths[index]!, index === paths.length - 1));
  socket.once("connect", send);
  socket.on("data", chunk => {
    bytes += String(chunk);
    if (cancelAfter && bytes.includes(cancelAfter)) {
      socket.destroy();
      resolve({ wire: normalizeWire(bytes), end: "client-cancelled" });
      return;
    }
    if (index >= paths.length - 1 || !bytes.endsWith("alive")) return;
    index++;
    send();
  });
  socket.on("error", error => resolve({ wire: normalizeWire(bytes), end: `error ${"code" in error ? error.code : error.message}` }));
  socket.on("close", () => resolve({ wire: normalizeWire(bytes), end: "server-closed" }));
}

function exchange(paths: string[], cancelAfter?: string): Promise<ExchangeResult> {
  return new Promise(resolve => exchangeSocket(paths, cancelAfter, resolve));
}

const results: Record<string, unknown> = {};
for (const { name, paths, cancelAfter } of exchanges) {
  const client = await exchange(paths, cancelAfter);
  await closed.get(name);
  results[name] = { client, server: traces.get(name) ?? null };
}
results.clientErrors = clientErrors;
server.close();
console.log(JSON.stringify(results));
