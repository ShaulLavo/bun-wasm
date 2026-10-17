import assert from "node:assert/strict";

async function check(signal: "SIGINT" | "SIGTERM" | "SIGPIPE", number: number, mode: "handled" | "default" | "removed" | "stdio", ownCode = 0) {
  const child = Bun.spawn([process.execPath, "-e", `
    const handler = () => process.exit(${ownCode});
    ${mode === "handled" || mode === "removed" ? `process.on(${JSON.stringify(signal)}, handler);` : ""}
    ${mode === "stdio" ? 'process.stdout.on("error", () => {}); process.stderr.on("error", () => {});' : ""}
    ${mode === "removed" ? `process.removeListener(${JSON.stringify(signal)}, handler);` : ""}
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    assert.equal(new TextDecoder().decode(ready.value).trim(), "ready");
    child.kill(signal);
    const status = await child.exited;
    assert.equal(status, mode === "handled" ? ownCode : 128 + number);
    assert.equal(child.exitCode, mode === "handled" ? ownCode : null);
    assert.equal(child.signalCode, mode === "handled" ? null : signal);
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
      assert.equal(await child.exited, handled ? 0 : 128 + number);
      assert.equal(child.exitCode, handled ? 0 : null);
      assert.equal(child.signalCode, handled ? null : signal);
      assert.equal(child.exitedDueToTimeout, false);
      console.log("self", signal, handled, handled ? 0 : 128 + number, child.signalCode);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await child.stdout.cancel();
      await child.stderr.cancel();
    }
  }
}
