import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { echo } from "./abstract-peer.ts";

const directory = process.env.BUN_WASM_UNIX_TEST_DIR || "/tmp";
mkdirSync(directory, { recursive: true });
const path = `${directory}/bunwasm-unix.sock`;
const sockets = new Set<Socket>();
const server = createServer({ allowHalfOpen: true }, socket => {
  sockets.add(socket);
  let received = "";
  socket.on("data", bytes => { received += bytes.toString(); });
  socket.on("end", () => socket.end(`echo:${received}`));
  socket.once("close", () => sockets.delete(socket));
});
function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
try {
  server.listen(path);
  await once(server, "listening");
  assert.equal(server.address(), path);
  const client = createConnection(path);
  sockets.add(client);
  let received = "";
  client.on("data", bytes => { received += bytes.toString(); });
  const closed = once(client, "close");
  client.end("request");
  await closed;
  sockets.delete(client);
  assert.equal(received, "echo:request");
  assert.equal(client.remoteAddress, undefined);
  await closeServer();
  assert.equal(existsSync(path), false);
  console.log("unix path echo, half-close and unlink ok");
} finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await closeServer();
}

// Linux abstract names: a leading NUL selects Waffle's runtime network namespace, with no
// cwd join and no filesystem node. Run from a relative cwd so a join would be visible.
const name = "\0nuxt-x.sock";
process.chdir(directory);
const abstract = createServer({ allowHalfOpen: true }, socket => {
  let received = "";
  socket.on("data", bytes => { received += bytes.toString(); });
  socket.on("end", () => socket.end(`echo:${received}`));
});
try {
  abstract.listen(name);
  await once(abstract, "listening");
  assert.equal(abstract.address(), name);
  assert.equal(await echo(name, "main"), "echo:main");
  const worker = new Worker(new URL("./abstract-worker.ts", import.meta.url), { workerData: { name } });
  assert.equal((await once(worker, "message"))[0], "echo:worker");
  // The child dials while this process keeps serving, so the call must not block the loop.
  const child = await promisify(execFile)(process.execPath, [new URL("./abstract-child.ts", import.meta.url).pathname, name.slice(1)], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), "echo:child");
  assert.throws(() => unlinkSync(name), { code: "ERR_INVALID_ARG_VALUE" });
  console.log("abstract listen, worker and child echo ok");
} finally {
  await close(abstract);
}

const web = createHttpServer((incoming, response) => response.end(`url=${incoming.url}`));
try {
  await once(web.listen(name), "listening");
  assert.equal(web.address(), name);
  assert.equal(await get(name), "url=/module");
  console.log("abstract http socketPath ok");
} finally {
  await close(web);
}

// Only a leading NUL is abstract: this joins the cwd and fails, as Node reports EINVAL.
const relative = createServer();
const outcome = await new Promise<string>(resolve => {
  relative.once("error", error => resolve(String(Reflect.get(error, "code"))));
  relative.once("listening", () => { relative.close(); resolve("listening"); });
  relative.listen("rel\0x");
});
assert.equal(outcome, "EINVAL");
console.log("relative NUL path still EINVAL");

function get(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: "/module", agent: false }, response => {
      let body = "";
      response.on("data", bytes => { body += bytes.toString(); });
      response.on("end", () => resolve(body));
    }).on("error", reject).end();
  });
}

function close(listener: Server | ReturnType<typeof createHttpServer>): Promise<void> {
  if (!listener.listening) return Promise.resolve();
  return new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}
