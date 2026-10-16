import { spawnSync } from "node:child_process";

// Native uses its real TERM interruption; the cooperative Node adapter needs explicit KILL.
const nodeHost = process.env.BUNWASM_TEST_HOST === "node";
const stopSignal = nodeHost ? "SIGKILL" : "SIGTERM";
const stopStatus = nodeHost ? 137 : 143;
const cmd = (code) => [process.execPath, "-e", code];
const large = Bun.spawnSync(cmd("process.stdout.write('x'.repeat(1200000)); process.stderr.write('y'.repeat(1200000))"));
console.log("large output", large.exitCode, large.stdout.length, large.stderr.length);
const input = Bun.spawnSync(cmd("console.log((await Bun.stdin.text()).length)"), { stdin: new Uint8Array(1200000) });
console.log("large input", input.exitCode, input.stdout.toString().trim());
const timed = spawnSync("bun", ["-e", "while (true) {}"], { timeout: 100, killSignal: stopSignal });
console.log("cpu timeout", timed.status, timed.signal === stopSignal, timed.error?.code);
const waiting = Bun.spawn(cmd("await Bun.stdin.text()"), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
setTimeout(() => waiting.kill("SIGKILL"), 100);
console.log("blocked input kill", await waiting.exited, waiting.signalCode);
const missing = Bun.spawnSync(cmd("console.log('never')"), { cwd: "/does-not-exist" });
console.log("missing cwd", missing.error.code);
const nested = Bun.spawnSync(cmd("const c = Bun.spawnSync([process.execPath, '-e', 'console.log(99)']); console.log(c.exitCode, c.stdout.toString().trim())"));
console.log("nested", nested.exitCode, nested.stdout.toString().trim());
const clockStart = Date.now();
const clock = Bun.spawn(cmd("Bun.sleepSync(3000)"), { timeout: 100, killSignal: stopSignal, stdout: "pipe", stderr: "pipe" });
const clockStatus = await clock.exited;
console.log("clock timeout", Date.now() - clockStart < 1500, clockStatus === stopStatus, clock.signalCode === stopSignal);
const children = Array.from({ length: 4 }, () => Bun.spawn(cmd("setInterval(() => {}, 1000)"), { stdout: "pipe", stderr: "pipe" }));
console.log("child limit", Bun.spawnSync(cmd("console.log('never')")).error.code);
for (const child of children) child.kill(stopSignal);
const stopped = await Promise.all(children.map((child) => child.exited));
console.log("children stopped", stopped.every((code) => code === stopStatus), children.every((child) => child.signalCode === stopSignal));
const inherited = Bun.spawnSync(cmd("const c = Bun.spawnSync(['bun', '-e', 'console.log(42)'], {stdout:'inherit'}); process.exit(c.exitCode)"));
console.log("inherit", inherited.exitCode, inherited.stdout.toString().trim());
const done = Bun.spawn(cmd(""), { stdout: "pipe", stderr: "pipe" });
Bun.sleepSync(150);
done.kill();
console.log("late kill", await done.exited, done.signalCode);
for (const code of [23, 143]) {
  const own = Bun.spawnSync(cmd(`process.exit(${code})`));
  console.log("own exit", own.exitCode, own.signalCode);
}
