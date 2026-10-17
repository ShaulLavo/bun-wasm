import assert from "node:assert/strict";

const buffered = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
const bufferedReader = buffered.getReader();
await bufferedReader.cancel();
if (!(await bufferedReader.read()).done) throw new Error("cancel kept buffered output");

for (const fd of [1, 2]) {
  for (const mode of ["default", "listener", "callback", "trycatch"]) {
    const name = fd === 2 ? "stderr" : "stdout";
    const handle = 'error => { if (error) process.exit(error.code === "EPIPE" && error.errno === -32 ? 42 : 43); }';
    const source = `
      const stream = process.${name};
      const handled = ${handle};
      ${mode === "listener" ? 'stream.on("error", handled);' : ""}
      ${mode === "trycatch" ? 'const { writeSync } = require("node:fs");' : ""}
      const chunk = "x".repeat(65536);
      for (;;) {
        ${mode === "trycatch" ? `try { writeSync(${fd}, chunk); } catch (error) { handled(error); }` : `stream.write(chunk${mode === "callback" ? ", handled" : ""});`}
        await new Promise(setImmediate);
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
    const reader = child[name].getReader();
    let drained: Promise<string> | undefined;
    try {
      const first = await reader.read();
      if (first.done || !first.value.byteLength) throw new Error("child did not reach its output loop");
      await reader.cancel();
      drained = new Response(fd === 2 ? child.stdout : child.stderr).text();
      const code = await child.exited;
      await drained;
      const handled = mode !== "default";
      console.log("closed child", name, mode === "default" ? false : mode === "listener" ? true : mode, code);
      assert.equal(code, handled ? 42 : 1);
      assert.equal(child.exitCode, handled ? 42 : 1);
      assert.equal(child.signalCode, null);
      assert.equal(child.exitedDueToTimeout, false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await reader.cancel();
      if (drained) await drained; else await (fd === 2 ? child.stdout : child.stderr).cancel();
    }
  }
}

for (const fd of [1, 2]) {
  const name = fd === 2 ? "stderr" : "stdout";
  const source = `
    const source = 'process.${name}.on("error", e => process.exit(e.code === "EPIPE" ? 42 : 43)); for (;;) { process.${name}.write("x".repeat(65536)); await new Promise(setImmediate); }';
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
  const reader = child[name].getReader();
  let drained: Promise<string> | undefined;
  try {
    const first = await reader.read();
    if (first.done || !first.value.byteLength) throw new Error("inherited child did not reach its output loop");
    await reader.cancel();
    drained = new Response(fd === 2 ? child.stdout : child.stderr).text();
    const code = await child.exited;
    await drained;
    console.log("closed inherited child", name, code);
    assert.equal(code, 42);
    assert.equal(child.exitCode, 42);
    assert.equal(child.signalCode, null);
    assert.equal(child.exitedDueToTimeout, false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await reader.cancel();
    if (drained) await drained; else await (fd === 2 ? child.stdout : child.stderr).cancel();
  }
}
