import assert from "node:assert/strict";
import { isMainThread, workerData } from "node:worker_threads";
import { SubprocessHost, childTransport, type ChildTransport, type ChildWorker } from "../src/subprocess.ts";
import { launchNodeChild } from "../scripts/node-child.ts";

if (!isMainThread) {
  const data: { transport: ChildTransport; failure: "ENOENT" | "EACCES" | undefined } = workerData;
  const child = childTransport(data.transport);
  if (data.failure) child.startFailed(data.failure);
  else { child.started(); child.finish(23); }
} else {
  const workers: ChildWorker[] = [];
  const host = new SubprocessHost({
    output() {},
    launch(meta, transport) {
      const entry = meta.argv[1] === "pre-bootstrap" ? new URL("data:text/javascript,throw new Error('pre-bootstrap failure')")
        : meta.argv[1] === "early-exit" ? new URL("data:text/javascript,process.exit(0)")
        : new URL(import.meta.url);
      const worker = launchNodeChild(entry, { workerData: { transport, failure: meta.argv[1] } }, transport);
      workers.push(worker);
      return worker;
    },
  });
  try {
    for (const failure of ["ENOENT", "EACCES"] as const) {
      assert.equal(host.spawn(JSON.stringify({ argv: ["fixture", failure] })), -1);
      const error = JSON.parse(host.lastError!);
      assert.equal(error.code, failure);
      assert.equal(error.errno, failure === "ENOENT" ? -2 : -13);
      assert.equal(error.path, "fixture");
      assert.equal(host.children.size, 0);
      assert.equal(host.handles.size, 0);
    }
    for (const failure of ["pre-bootstrap", "early-exit"]) {
      assert.equal(host.spawn(JSON.stringify({ argv: ["node", failure] })), -1);
      assert.equal(JSON.parse(host.lastError!).code, "EACCES");
      assert.equal(host.children.size, 0);
      assert.equal(host.handles.size, 0);
    }
    const child = host.spawn(JSON.stringify({ argv: ["fixture"] }));
    assert.ok(child > 0);
    while (host.wait(child) === -2) host.poll(1);
    assert.equal(host.wait(child), 23);
    host.close(child);
    console.log("startup acknowledgement and typed failures passed");
  } finally {
    host.dispose();
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
