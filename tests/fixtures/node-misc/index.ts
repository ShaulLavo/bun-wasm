import os from "node:os";
import { StringDecoder } from "string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import * as childProcess from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import qs from "node:querystring";
import { EOL } from "os";
import util from "node:util";
import process2 from "node:process";

console.log("os:", os.EOL === "\n", EOL === "\n", typeof os.cpus().length, os.endianness(), typeof os.tmpdir(), os.platform());
const dec = new StringDecoder("utf8");
const euro = Buffer.from("€");
console.log("string_decoder:", dec.write(euro.subarray(0, 1)) + dec.write(euro.subarray(1)) + dec.end());
console.log("timers/promises:", await sleep(2, "slept"));
console.log("querystring:", qs.stringify({ a: [1, 2], b: "x y" }), JSON.stringify(qs.parse("a=1&a=2&b=x%20y")));
console.log("net.isIP:", net.isIP("127.0.0.1"), net.isIP("::1"), net.isIP("nope"));
console.log("process module:", process2 === process);
console.log("util default:", typeof util.inspect);
const httpServer = createServer();
console.log("http.createServer:", typeof httpServer.listen === "function");
httpServer.close();
const endpoint = new URL(process.env.TEST_SERVER);
await new Promise<void>((resolve, reject) => {
  const socket = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) });
  socket.once("error", reject);
  socket.once("connect", () => { console.log("net.connect:", true); socket.end(); });
  socket.once("close", () => { resolve(); });
});

const missingCommand = "bun-wasm-no-such-executable";
function validError(error, syscall) {
  if (!(error instanceof Error) || error.code !== "ENOENT") return false;
  return error.errno === -2 && error.path === missingCommand && error.syscall === syscall &&
    JSON.stringify(error.spawnargs) === '["argument"]';
}
const missingChild = childProcess.spawn(missingCommand, ["argument"]);
const failedSpawn = await new Promise((resolve) => {
  let error;
  const events = [];
  const timer = setTimeout(() => { missingChild.kill(); resolve(false); }, 1000);
  missingChild.on("spawn", () => events.push("spawn"));
  missingChild.on("exit", () => events.push("exit"));
  missingChild.on("error", (value) => { error = value; events.push("error"); });
  missingChild.on("close", (code, signal) => {
    clearTimeout(timer);
    events.push("close");
    resolve(validError(error, `spawn ${missingCommand}`) && missingChild.pid === undefined && code === -2 && signal === null &&
      missingChild.exitCode === -2 && missingChild.stdin?.destroyed === true &&
      missingChild.stdout?.readableEnded === true && missingChild.stderr?.readableEnded === true &&
      JSON.stringify(events) === '["error","close"]');
  });
});
console.log("child_process.spawn failure:", failedSpawn);
const nodeSync = childProcess.spawnSync(missingCommand, ["argument"]);
console.log("child_process.spawnSync failure:", validError(nodeSync.error, `spawnSync ${missingCommand}`) && nodeSync.status === null && nodeSync.signal === null);
console.log("Bun.which:", Bun.which(missingCommand));
let syncFailure = false;
try {
  Bun.spawnSync({ cmd: [missingCommand] });
} catch (error) {
  syncFailure = error instanceof Error && error.code === "ENOENT" && error.errno === -2 && error.path === missingCommand;
}
console.log("Bun.spawnSync failure:", syncFailure);
try {
  const child = Bun.spawn({ cmd: [missingCommand] });
  child.kill();
  console.log("Bun.spawn throws:", false);
} catch (error) {
  console.log("Bun.spawn throws:", error instanceof Error && error.code === "ENOENT" && error.errno === -2 && error.path === missingCommand);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("served"); } });
try {
  console.log("Bun.serve:", await (await fetch(`http://127.0.0.1:${server.port}/`)).text());
} finally {
  await server.stop(true);
}
console.log("fetch:", await (await fetch(new URL("/text", endpoint))).text());
try {
  await fetch("http://127.0.0.1:9/");
  console.log("fetch resolved");
} catch (err) {
  console.log("fetch rejects:", err instanceof TypeError);
}
console.log("fetch file: URL:", await (await fetch(import.meta.url)).text().then((t) => t.startsWith("import os")));
