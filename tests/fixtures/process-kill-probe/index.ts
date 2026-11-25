import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

function probeCode(pid: number): "ok" | string {
  try {
    assert.equal(process.kill(pid, 0), true);
    return "ok";
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert.equal(typeof code, "string");
    return code!;
  }
}

const sibling = Bun.spawn([process.execPath, "-e", `
  console.log("ready");
  await Bun.stdin.text();
`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" });

const siblingReader = sibling.stdout.getReader();
try {
  assert.equal(new TextDecoder().decode((await siblingReader.read()).value).trim(), "ready");
  assert.equal(probeCode(process.pid), "ok");
  assert.equal(probeCode(sibling.pid), "ok");
  assert.equal(probeCode(999999), "ESRCH");

  // Direct child of root must see EPERM (not ESRCH) when probing process.ppid (logical PID 1).
  const direct = Bun.spawn([process.execPath, "-e", `
    function probe(pid) {
      try {
        return process.kill(pid, 0) === true ? "ok" : "bad";
      } catch (error) {
        return error.code;
      }
    }
    console.log(JSON.stringify({
      self: probe(process.pid),
      ppid: process.ppid,
      parent: probe(process.ppid),
      sibling: probe(${sibling.pid}),
      missing: probe(999999),
    }));
  `], { stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" });
  const directOut = await new Response(direct.stdout).text();
  assert.equal(await direct.exited, 0);
  const directResult = JSON.parse(directOut.trim()) as {
    self: string;
    ppid: number;
    parent: string;
    sibling: string;
    missing: string;
  };
  assert.deepEqual(directResult, {
    self: "ok",
    ppid: process.pid,
    parent: "EPERM",
    sibling: "EPERM",
    missing: "ESRCH",
  });

  // A worker_threads.Worker shares process.pid; its private execution handle must report ESRCH.
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    function probe(pid) {
      try {
        return process.kill(pid, 0) === true ? "ok" : "bad";
      } catch (error) {
        return error.code;
      }
    }
    parentPort.postMessage({ pid: process.pid, self: probe(process.pid) });
    parentPort.on("message", () => process.exit(0));
  `, { eval: true });
  try {
    const workerInfo = await new Promise<{ pid: number; self: string }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.deepEqual(workerInfo, { pid: process.pid, self: "ok" });
    const afterWorker = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    assert.equal(await afterWorker.exited, 0);
    // Between direct.pid and afterWorker.pid lies the live worker's private execution handle.
    assert.ok(afterWorker.pid > direct.pid + 1);
    for (let handle = direct.pid + 1; handle < afterWorker.pid; handle++) {
      assert.equal(probeCode(handle), "ESRCH");
    }
    assert.equal(probeCode(process.pid), "ok");
    worker.postMessage("stop");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  } finally {
    await worker.terminate();
  }

  const mid = Bun.spawn([process.execPath, "-e", `
    const grand = Bun.spawn([process.execPath, "-e", \`
      function probe(pid) {
        try {
          return process.kill(pid, 0) === true ? "ok" : "bad";
        } catch (error) {
          return error.code;
        }
      }
      console.log(JSON.stringify({
        self: probe(process.pid),
        parent: probe(process.ppid),
        sibling: probe(${sibling.pid}),
        missing: probe(999999),
      }));
    \`], { stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" });
    const out = await new Response(grand.stdout).text();
    const status = await grand.exited;
    if (status !== 0) throw new Error("grandchild exited " + status);
    process.stdout.write(out);
    await Bun.stdin.text();
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" });

  const midReader = mid.stdout.getReader();
  try {
    const chunk = await midReader.read();
    const result = JSON.parse(new TextDecoder().decode(chunk.value).trim()) as {
      self: string;
      parent: string;
      sibling: string;
      missing: string;
    };
    assert.deepEqual(result, {
      self: "ok",
      parent: "EPERM",
      sibling: "EPERM",
      missing: "ESRCH",
    });
    // Probing a live child succeeds without ending it.
    assert.equal(probeCode(mid.pid), "ok");
    mid.stdin.end();
    assert.equal(await mid.exited, 0);
    // Once reaped, the same PID reports ESRCH.
    assert.equal(probeCode(mid.pid), "ESRCH");
  } finally {
    mid.kill("SIGKILL");
    await mid.exited;
    await midReader.cancel();
    await mid.stderr.cancel();
  }

  sibling.stdin.end();
  assert.equal(await sibling.exited, 0);
  assert.equal(probeCode(sibling.pid), "ESRCH");
  console.log("process.kill(pid, 0): ok, EPERM, ESRCH");
} finally {
  sibling.kill("SIGKILL");
  await sibling.exited;
  await siblingReader.cancel();
  await sibling.stderr.cancel();
}
