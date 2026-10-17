import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

async function check(signal: "SIGINT" | "SIGTERM" | "SIGPIPE", number: number, mode: "handled" | "default" | "removed" | "stdio", ownCode = 0) {
  const ignored = signal === "SIGPIPE" && (mode === "default" || mode === "stdio");
  const statusCode = ignored ? 17 : mode === "handled" ? ownCode : 128 + number;
  const signalCode = ignored || mode === "handled" ? null : signal;
  const child = Bun.spawn([process.execPath, "-e", `
    const handler = () => process.exit(${ownCode});
    ${mode === "handled" || mode === "removed" ? `process.on(${JSON.stringify(signal)}, handler);` : ""}
    ${mode === "stdio" ? 'process.stdout.on("error", () => {}); process.stderr.on("error", () => {});' : ""}
    ${mode === "removed" ? `process.removeListener(${JSON.stringify(signal)}, handler);` : ""}
    console.log("ready");
    ${ignored ? "await Bun.stdin.text(); process.exit(17);" : "setInterval(() => {}, 1000);"}
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    assert.equal(new TextDecoder().decode(ready.value).trim(), "ready");
    child.kill(signal);
    // Keep ignored guests alive until the synchronous signal decision has been made.
    if (ignored) child.stdin.end();
    const status = await child.exited;
    assert.equal(status, statusCode);
    assert.equal(child.exitCode, signalCode === null ? statusCode : null);
    assert.equal(child.signalCode, signalCode);
    assert.equal(child.exitedDueToTimeout, false);
    console.log(mode, signal, status, child.signalCode);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await reader.cancel();
    await child.stderr.cancel();
  }
}

for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]] as const) {
  await check(signal, number, "handled");
  await check(signal, number, "default");
  await check(signal, number, "removed");
}
for (const code of [23, 143]) await check("SIGTERM", 15, "handled", code);
await check("SIGPIPE", 13, "stdio");

const once = Bun.spawn([process.execPath, "-e", `
  process.once("SIGINT", () => console.log("handled"));
  console.log("ready");
  setInterval(() => {}, 1000);
`], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
const onceReader = once.stdout.getReader();
try {
  assert.equal(new TextDecoder().decode((await onceReader.read()).value).trim(), "ready");
  once.kill("SIGINT");
  assert.equal(new TextDecoder().decode((await onceReader.read()).value).trim(), "handled");
  once.kill("SIGINT");
  assert.equal(await once.exited, 130);
  assert.equal(once.signalCode, "SIGINT");
  assert.equal(once.exitedDueToTimeout, false);
  console.log("once restored default", once.signalCode);
} finally {
  once.kill("SIGKILL");
  await once.exited;
  await onceReader.cancel();
  await once.stderr.cancel();
}

const distinct = Bun.spawn([process.execPath, "-e", `
  const seen = new Set();
  for (const name of ["SIGINT", "SIGTERM"]) process.on(name, signal => {
    seen.add(signal);
    if (seen.size === 2) process.exit(0);
  });
  console.log("ready");
  setInterval(() => {}, 1000);
`], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
const distinctReader = distinct.stdout.getReader();
try {
  assert.equal(new TextDecoder().decode((await distinctReader.read()).value).trim(), "ready");
  distinct.kill("SIGINT");
  distinct.kill("SIGTERM");
  assert.equal(await distinct.exited, 0);
  assert.equal(distinct.signalCode, null);
  assert.equal(distinct.exitedDueToTimeout, false);
  console.log("distinct handled signals", 0, distinct.signalCode);
} finally {
  distinct.kill("SIGKILL");
  await distinct.exited;
  await distinctReader.cancel();
  await distinct.stderr.cancel();
}

for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGPIPE", 13]] as const) {
  for (const handled of [false, true]) {
    const child = Bun.spawn([process.execPath, "-e", `
      ${handled ? `process.on(${JSON.stringify(signal)}, () => process.exit(0));` : ""}
      process.kill(process.pid, ${JSON.stringify(signal)});
      ${handled ? 'setInterval(() => {}, 1000);' : 'process.exit(99);'}
    `], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
    try {
      const status = handled ? 0 : signal === "SIGPIPE" ? 99 : 128 + number;
      const signaled = !handled && signal !== "SIGPIPE";
      assert.equal(await child.exited, status);
      assert.equal(child.exitCode, signaled ? null : status);
      assert.equal(child.signalCode, signaled ? signal : null);
      assert.equal(child.exitedDueToTimeout, false);
      console.log("self", signal, handled, status, child.signalCode);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await child.stdout.cancel();
      await child.stderr.cancel();
    }
  }
}

const overflow = Bun.spawnSync([process.execPath, "-e", `
  process.stdout.write("overflow");
  setInterval(() => {}, 1000);
`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", maxBuffer: 1 });
assert.equal(overflow.error?.code, "ENOBUFS");
assert.equal(overflow.success, false);
assert.equal(overflow.exitCode, null);
assert.equal(overflow.signalCode, "SIGKILL");
console.log("sync maxBuffer selected", overflow.signalCode);

for (const [mode, source] of [
  ["signal", 'process.kill(process.pid, "SIGPIPE")'],
  ["EPIPE", 'throw Object.assign(new Error("escaping broken pipe"), { code: "EPIPE" })'],
]) {
  const worker = new Worker(source, { eval: true, stdout: true, stderr: true });
  const errors: Error[] = [];
  worker.on("error", error => { errors.push(error); });
  let expired = false;
  const timer = setTimeout(() => { expired = true; void worker.terminate(); }, 5000);
  try {
    const code = await new Promise<number>(resolve => worker.once("exit", resolve));
    assert.equal(expired, false);
    assert.equal(code, mode === "EPIPE" ? 1 : 0);
    assert.equal(errors.length, mode === "EPIPE" ? 1 : 0);
    if (mode === "EPIPE") assert.equal(errors[0].message, "escaping broken pipe");
    console.log("worker", mode, "exit", code);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    worker.stdout.destroy();
    worker.stderr.destroy();
  }
}
