const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); for (;;) {}'], {
  stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL",
});
const reader = child.stdout.getReader();
try {
  const ready = await reader.read();
  console.log("child", new TextDecoder().decode(ready.value).trim());
  const started = Date.now();
  child.kill("SIGTERM");
  const status = await child.exited;
  if (!("exitedDueToTimeout" in child) || typeof child.exitedDueToTimeout !== "boolean") throw new Error("Missing timeout status");
  console.log("interrupt", status, child.signalCode, child.exitedDueToTimeout, Date.now() - started < 10_000);
} finally {
  child.kill("SIGKILL");
  await child.exited;
  await reader.cancel();
  await child.stderr.cancel();
}

export {};
