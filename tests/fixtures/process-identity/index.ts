import assert from "node:assert/strict";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { assertIdentityTree, assertNonrootTree, assertParentExit, decodeExitObservation, decodeIdentity, decodeThread, decodeTree } from "./oracle.ts";

const identity = () => ({ pid: process.pid, ppid: process.ppid });
const diagnostic = (value: unknown) => { if (process.argv.includes("--snapshot")) console.log(JSON.stringify(value)); };

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

async function nonroot(creator: ReturnType<typeof identity>) {
  const handle = Bun.spawn([process.execPath, "run", import.meta.filename, "--leader"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.exited,
  ]);
  assert.equal(status, 0, stderr);
  const lines = stdout.trim().split("\n");
  const value: unknown = JSON.parse(lines.at(-1) ?? "null");
  const tree = decodeTree(value);
  diagnostic({ stage: "nonroot", handle: handle.pid, tree });
  assertNonrootTree(handle.pid, creator, tree);
}

async function parentExit() {
  const directory = mkdtempSync("./identity-exit-");
  const gate = `${directory}/release`;
  try {
    const parent = Bun.spawn([process.execPath, "run", import.meta.filename, "--orphan-parent", gate], { stdout: "pipe", stderr: "pipe" });
    const capture = Promise.all([new Response(parent.stdout).text(), new Response(parent.stderr).text()]);
    let status: number;
    try { status = await parent.exited; }
    finally { writeFileSync(gate, "release"); }
    const [stdout, stderr] = await capture;
    assert.equal(status, 0, stderr);
    const reports = stdout.trim().split("\n").map(line => decodeExitObservation(JSON.parse(line)));
    const creator = reports.find(report => report.kind === "creator");
    const survivor = reports.find(report => report.kind === "survivor");
    assert.ok(creator && survivor);
    assert.equal(creator.identity.pid, parent.pid);
    assert.equal(creator.identity.ppid, process.pid);
    assertParentExit(creator.identity, creator.child, survivor.before, survivor.after);
    diagnostic({ stage: "parent-exit", creator, survivor });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function exitParticipant(): Promise<boolean> {
  const gate = process.argv.at(-1);
  if (process.argv.includes("--orphan-parent")) {
    const child = Bun.spawn([process.execPath, "run", import.meta.filename, "--orphan", String(gate)], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    child.unref();
    console.log(JSON.stringify({ kind: "creator", identity: identity(), child: child.pid }));
    return true;
  }
  if (!process.argv.includes("--orphan")) return false;
  assert.ok(gate);
  const before = identity();
  while (!existsSync(gate)) await Bun.sleep(1);
  console.log(JSON.stringify({ kind: "survivor", before, after: identity() }));
  return true;
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
  if (await exitParticipant()) return;
  const root = identity();
  const siblings = await Promise.all([child(), child()]);
  diagnostic({ stage: "subprocesses", root, siblings });
  const thread = decodeThread(await worker());
  const snapshot = { root, siblings, thread };
  if (process.argv.includes("--leader")) console.log(JSON.stringify(snapshot));
  else diagnostic(snapshot);
  assertIdentityTree(snapshot, process.argv.includes("--virtual-root"));
  if (process.argv.includes("--leader")) return;
  await nonroot(root);
  if (process.argv.includes("--virtual-root")) await parentExit();
  console.log("process identity: root, siblings, threads and child-from-thread");
}

await main();
