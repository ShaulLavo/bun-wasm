import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
for (const serialization of ["json", "advanced"] as const) for (const kind of ["fork", "spawn"]) {
  const child = kind === "fork" ? fork("./child.ts", [], { silent: true, serialization }) : spawn(process.execPath, ["./child.ts"], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization });
  child.on("error", error => { throw error; });
  child.stderr?.on("data", data => process.stderr.write(data));
  const messages: any[] = [];
  child.on("message", message => {
    messages.push(message);
    if (messages.length === 1) child.send({ text: "x".repeat(2 * 1024 * 1024), n: 17 }, error => assert.equal(error, null));
    else child.disconnect();
  });
  let disconnected = false;
  child.on("disconnect", () => { disconnected = true; assert.equal(child.connected, false); });
  await new Promise<void>(resolve => child.on("close", code => { assert.equal(code, 0); resolve(); }));
  assert.equal(disconnected, true);
  assert.deepEqual(messages, [{ ready: true }, { length: 2097152, n: 17 }]);
  console.log(kind, serialization, "IPC round trip and disconnect pass");
}
const graph = { buffer: Buffer.from([2, 5, 9]), map: new Map([["key", 5]]), date: new Date(1234), big: 19n, cycle: null as unknown };
graph.cycle = graph;
let resolveGraph: (value: unknown) => void;
const received = new Promise(resolve => { resolveGraph = resolve; });
const bunChild = Bun.spawn([process.execPath, "-e", 'process.on("message", message => process.send(message));'], {
  stdout: "pipe", stderr: "pipe", serialization: "advanced",
  ipc(value, child) { resolveGraph(value); child.disconnect(); },
});
bunChild.send(graph);
const echoed = await received as typeof graph;
assert.equal(echoed.cycle, echoed);
assert.equal(Buffer.isBuffer(echoed.buffer), true);
assert.equal(echoed.buffer.toString("hex"), "020509");
assert.equal(echoed.map.get("key"), 5);
assert.equal(echoed.date.getTime(), 1234);
assert.equal(echoed.big, 19n);
assert.equal(await bunChild.exited, 0);
console.log("Bun advanced IPC graph pass");
