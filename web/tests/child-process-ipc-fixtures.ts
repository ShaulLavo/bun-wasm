// Guest sources are compiled by the real guest transpiler, not run on the test host.
export const ipcChild = `
process.send({ kind: "ready", connected: process.connected, pid: process.pid });
let received = 0;
process.on("message", message => {
  if (message.kind === "exit") process.exit(0);
  if (message.kind === "finish") {
    process.send({ kind: "finished", received });
    return;
  }
  received++;
  process.send({ kind: "reply", index: message.index, token: message.token, length: message.payload.length });
});
process.on("disconnect", () => {
  if (process.connected) throw Error("child remained connected");
});
`;

const ipcExitBurstChild = `
const count = 257;
let callbacks = 0;
function exit(error) {
  if (error) throw error;
  process.exit(0);
}
for (let index = 0; index < count; index++) {
  process.send({ kind: "burst", index, token }, error => {
    if (error) throw error;
    callbacks++;
    if (callbacks !== count) return;
    process.send({ kind: "callbacks", count: callbacks }, exit);
  });
}
`;

export function ipcParent(token: string, port: number) {
  return `
import { fork, spawn } from "node:child_process";
const token = ${JSON.stringify(token)};
const assert = (ok, label) => { if (!ok) throw Error(label); };
const closed = child => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(Error("child close " + code + " " + signal)));
});
async function exchange(id) {
  const child = fork("/home/user/ipc-child.ts", [], { silent: true });
  const done = closed(child);
  assert(child.connected, "implicit fork channel");
  assert(child.stdio.length === 4 && child.stdio[3] === null, "IPC stdio shape");
  const replies = [];
  const callbacks = [];
  let ready = false;
  let disconnected = 0;
  child.on("disconnect", () => disconnected++);
  child.on("message", message => {
    if (message.kind === "ready") {
      ready = message.connected;
      setTimeout(() => child.send({ kind: "finish" }), 20);
      return;
    }
    if (message.kind === "reply") { replies.push(message); return; }
    assert(message.kind === "finished" && message.received === 12, "queued messages reached child");
    child.disconnect();
    assert(!child.connected, "parent disconnect flag");
  });
  // Queue before readiness, with data larger than a process pipe. Each child has its own token.
  for (let index = 0; index < 12; index++) {
    child.send({ index, token: token + id, payload: "界".repeat(8192) }, error => {
      assert(error === null || error === undefined, "send callback error"); callbacks.push(index);
    });
  }
  await done;
  assert(ready && replies.length === 12 && callbacks.length === 12, "ready, replies and callbacks");
  assert(disconnected === 1 && !child.connected, "one disconnect");
  assert(replies.every((reply, index) => reply.index === index && reply.token === token + id && reply.length === 8192), "dynamic JSON order and isolation");
  assert(callbacks.every((value, index) => value === index), "callback order");
  let sync = true;
  const error = await new Promise(resolve => {
    assert(child.send({ late: true }, error => { assert(!sync, "closed callback async"); resolve(error); }) === false, "closed send return");
    sync = false;
  });
  assert(error.code === "ERR_IPC_CHANNEL_CLOSED", "closed send error");
  return { id, ready, replies: replies.length, callbacks: callbacks.length, disconnected, closedError: error.code };
}
const exchanges = await Promise.all([exchange("a"), exchange("b")]);
const burst = spawn(process.execPath, ["-e", "const token=" + JSON.stringify(token) + ";" + ${JSON.stringify(ipcExitBurstChild)}], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const burstDone = closed(burst);
const indices = [];
let burstCallbacks = 0;
let burstDisconnects = 0;
burst.on("message", message => {
  if (message.kind === "callbacks") { burstCallbacks = message.count; return; }
  assert(message.kind === "burst" && message.token === token, "dynamic exit-burst frame");
  indices.push(message.index);
});
burst.on("disconnect", () => burstDisconnects++);
const occupiedUntil = Date.now() + 2000;
while (Date.now() < occupiedUntil) {}
await burstDone;
assert(indices.every((value, index) => value === index), "separate exit-burst frame order");
assert(burstDisconnects === 1 && !burst.connected, "exit-burst disconnect");
const exitBurst = { received: indices.length, last: indices.at(-1), callbacks: burstCallbacks, disconnected: burstDisconnects, connected: burst.connected };

const exitChild = spawn(process.execPath, ["-e", "process.send({bye:73});process.exit(0)"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const exitDone = closed(exitChild);
let bye = 0;
exitChild.on("message", message => bye = message.bye);
await exitDone;
assert(bye === 73 && !exitChild.connected, "exit drains IPC and closes channel");
const idle = fork("/home/user/ipc-idle.ts", [], { silent: true });
await closed(idle);
assert(!idle.connected, "unobserved child IPC does not hold child alive");
let unsupported = false;
try { fork("/home/user/ipc-child.ts", [], { serialization: "advanced" }); }
catch (error) { unsupported = error.code === "ERR_NOT_SUPPORTED_IN_WASM"; }
assert(unsupported, "advanced serialization explicitly rejected");
const self = fork("/home/user/ipc-self.ts", [], { silent: true });
const selfDone = closed(self);
let selfMessage = false;
let selfDisconnects = 0;
self.on("message", message => selfMessage = message.selfDisconnected);
self.on("disconnect", () => selfDisconnects++);
await selfDone;
assert(selfMessage && selfDisconnects === 1 && !self.connected, "child initiated disconnect");
let bunReply;
const bunChild = Bun.spawn([process.execPath, "-e", 'process.on("message", message => { process.send({token:message.token}); process.disconnect(); }); process.send({ready:true});'], {
  serialization: "json", stdout: "ignore", stderr: "inherit",
  ipc(message, child) { if (message.ready) child.send({ token }); else bunReply = message.token; }
});
assert(await bunChild.exited === 0 && bunReply === token && !bunChild.connected, "Bun JSON IPC callback and process.disconnect");
const report = { token, exchanges, exitBurst, bye, idleExited: true, advancedRejected: true, selfMessage, selfDisconnects, bunReply };
const server = Bun.serve({ port: ${port}, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/stop") { setTimeout(() => server.stop(true), 10); return new Response("stopped"); }
  return Response.json(report);
} });
console.log("ipc-preview-ready");
`;
}
