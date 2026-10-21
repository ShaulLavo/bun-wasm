import assert from "node:assert/strict";
import http from "node:http";
import { headerCases, verifyResponseHeaders } from "./contract.ts";

const failures: unknown[] = [];
const server = http.createServer((request, response) => {
  try { verifyResponseHeaders(response, request.url?.slice(1) ?? ""); }
  catch (error) { failures.push(error); response.destroy(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
function collectResponse(response: http.IncomingMessage, resolve: (body: string) => void, reject: (error: Error) => void) {
  let body = "";
  response.on("data", chunk => { body += chunk; });
  response.on("error", reject);
  response.on("end", () => resolve(body));
}
function receive(port: number, mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: `/${mode}`, agent: false }, response => collectResponse(response, resolve, reject));
    request.on("error", reject);
  });
}
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const mode of headerCases) {
    const body = await receive(address.port, mode);
    assert.equal(body, mode === "write" ? "bodytail" : "body");
  }
  assert.deepEqual(failures, []);
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log("HTTP implicit headers preserve hooks, wire bodies and repeated completion");
