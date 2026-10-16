import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const source = 'require("node:fs").writevSync(1, [Buffer.from("ready")]); Bun.sleepSync(20); process.exit(0)';
const properties = error => ({ code: error.code, errno: error.errno, syscall: error.syscall });
const expected = { code: "EPIPE", errno: -32, syscall: "write" };

async function bunRace() {
const bun = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
try {
  const reader = bun.stdout.getReader();
  assert.equal((await reader.read()).done, false);
  Bun.sleepSync(250);
  assert.equal(bun.exitCode, null);
  let failure;
  try { bun.stdin.write("racing child exit"); } catch (error) { failure = error; }
  assert.deepEqual(failure && properties(failure), expected);
  await reader.cancel();
  assert.equal(await bun.exited, 0);
  console.log("Bun stdin close race EPIPE -32 write");
} finally { bun.kill(); await bun.exited.catch(() => {}); }
}
async function nodeRace() {
const node = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
const closed = new Promise(resolve => node.once("close", resolve));
try {
  await new Promise(resolve => node.stdout.once("data", resolve));
  Bun.sleepSync(250);
  assert.equal(node.exitCode, null);
  const order = [];
  let callbackError;
  const event = new Promise(resolve => node.stdin.once("error", error => {
    order.push("event");
    resolve(error);
  }));
  node.stdin.write("racing child exit", error => { callbackError = error; order.push("callback"); });
  const error = await Promise.race([event, Bun.sleep(1000).then(() => { throw new Error("stdin write did not report the closed pipe"); })]);
  assert.deepEqual(properties(callbackError), expected);
  assert.deepEqual(properties(error), expected);
  assert.equal(callbackError, error);
  assert.deepEqual(order, ["callback", "event"]);
  console.log("Node stdin callback, event; EPIPE -32 write");
} finally { node.kill(); await closed; }
}
const failures = [];
for (const scenario of [bunRace, nodeRace]) {
  try { await scenario(); } catch (error) { failures.push(scenario.name + ": " + error.message); }
}
if (failures.length) throw new Error(failures.join("\n"));
