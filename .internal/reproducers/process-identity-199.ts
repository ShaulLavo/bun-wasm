import assert from "node:assert/strict";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

const identity = () => ({ pid: process.pid, ppid: process.ppid });

function decodeIdentity(text: string) {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("pid" in value) || !("ppid" in value)) throw new Error("Missing child identity");
  if (typeof value.pid !== "number" || typeof value.ppid !== "number") throw new Error("Invalid child identity");
  return { pid: value.pid, ppid: value.ppid };
}

async function child() {
  const handle = Bun.spawn([process.execPath, "run", import.meta.filename, "--child"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.exited,
  ]);
  assert.equal(status, 0, stderr);
  return { handle: handle.pid, identity: decodeIdentity(stdout) };
}

async function worker() {
  const handle = new Worker(import.meta.filename);
  const message = new Promise<unknown>((resolve, reject) => {
    handle.once("message", resolve);
    handle.once("error", reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    handle.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
  });
  const value = await message;
  await exited;
  return value;
}

async function main() {
  if (!isMainThread) {
    if (!parentPort) throw new Error("Missing worker parent port");
    parentPort.postMessage(identity());
    return;
  }
  if (process.argv.includes("--child")) { console.log(JSON.stringify(identity())); return; }
  const root = identity();
  const siblings = await Promise.all([child(), child()]);
  console.log(JSON.stringify({ stage: "subprocesses", root, siblings }));
  const thread = await worker();
  const snapshot = { root, siblings, thread };
  console.log(JSON.stringify(snapshot));
  assert.ok(root.pid > 0);
  assert.notEqual(siblings[0]!.handle, siblings[1]!.handle);
  for (const sibling of siblings) {
    assert.equal(sibling.identity.pid, sibling.handle, "child process.pid must equal its handle");
    assert.equal(sibling.identity.ppid, root.pid, "child process.ppid must name the virtual parent");
  }
  assert.deepEqual(thread, root, "worker threads must retain their process identity");
}

await main();
