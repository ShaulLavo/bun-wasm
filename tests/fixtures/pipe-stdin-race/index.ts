import assert from "node:assert/strict";
import { spawn } from "node:child_process";
// Ready is not proof of liveness: stdout may be drained after child completion.
// Hold the child at a real input barrier until the parent's continuation runs.
const source = 'const fs = require("node:fs"); fs.writevSync(1, [Buffer.from("ready")]); const release = Buffer.alloc(1); if (fs.readSync(0, release, 0, 1, null) !== 1 || release[0] !== 33) throw new Error("missing parent release"); process.exit(0)';
const properties = error => ({ code: error.code, errno: error.errno, syscall: error.syscall });
const expected = { code: "EPIPE", errno: -32, syscall: "write" };

async function bunRace() {
const bun = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
try {
  const reader = bun.stdout.getReader();
  assert.equal((await reader.read()).done, false);
  bun.stdin.write("!");
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
  node.stdin.write("!");
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
async function bufferedReady() {
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); console.log("input", await Bun.stdin.text())'], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let timeout;
  try {
    const reader = child.stdout.getReader();
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("buffered stdout readiness was not flushed before stdin read")), 3000);
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(ready.done, false);
    assert.equal(new TextDecoder().decode(ready.value), "ready\n");
    child.stdin.end("hello");
    let output = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }
    assert.equal(output, "input hello\n");
    assert.equal(await child.exited, 0);
    assert.equal(child.signalCode, null);
    assert.equal(await new Response(child.stderr).text(), "");
    console.log("Bun buffered stdout before stdin");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
}
const failures = [];
for (const scenario of [bunRace, nodeRace, bufferedReady]) {
  try { await scenario(); } catch (error) { failures.push(scenario.name + ": " + error.message); }
}
if (failures.length) throw new Error(failures.join("\n"));
