import assert from "node:assert/strict";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { assertIdentityTree, decodeIdentity, decodeThread } from "./process-identity-199-oracle.ts";

const identity = () => ({ pid: process.pid, ppid: process.ppid });

async function child() {
  const handle = Bun.spawn([process.execPath, "run", import.meta.filename, "--child"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.exited,
  ]);
  assert.equal(status, 0, stderr);
  const value: unknown = JSON.parse(stdout);
  return { handle: handle.pid, identity: decodeIdentity(value) };
}

async function worker(nested = false) {
  const handle = new Worker(import.meta.filename, { workerData: nested });
  const message = new Promise<unknown>((resolve, reject) => {
    handle.once("message", resolve);
    handle.once("error", reject);
  });
  const exited = new Promise<void>((resolve, reject) => {
    handle.once("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
  });
  try {
    const [value] = await Promise.all([message, exited]);
    return value;
  } finally { await handle.terminate(); }
}

async function main() {
  if (!isMainThread) {
    if (!parentPort) throw new Error("Missing worker parent port");
    if (workerData === true) { parentPort.postMessage(identity()); return; }
    const descendant = await child();
    const nested = decodeIdentity(await worker(true));
    parentPort.postMessage({ identity: identity(), child: descendant, nested });
    return;
  }
  if (process.argv.includes("--child")) { console.log(JSON.stringify(identity())); return; }
  const root = identity();
  const siblings = await Promise.all([child(), child()]);
  console.log(JSON.stringify({ stage: "subprocesses", root, siblings }));
  const thread = decodeThread(await worker());
  const snapshot = { root, siblings, thread };
  console.log(JSON.stringify(snapshot));
  assertIdentityTree(snapshot, process.argv.includes("--virtual-root"));
}

await main();
