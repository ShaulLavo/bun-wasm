import { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync } from "node:fs";

const command = [process.execPath, "-e"];
const sync = Bun.spawnSync(command.concat(["console.log(process.env.CHILD_VALUE); console.error('error'); process.exit(7)"]), {
  env: { CHILD_VALUE: "child-env" },
});
console.log("bun sync", sync.exitCode, sync.success, sync.stdout.toString().trim(), sync.stderr.toString().trim());

mkdirSync("child-dir", { recursive: true });
const child = Bun.spawn({ cmd: command.concat(["await Bun.write('shared.txt', process.cwd()); console.log(process.argv.slice(1).join(','))", "one", "two"]), cwd: "child-dir", stdout: "pipe", stderr: "pipe" });
const output = new Response(child.stdout).text();
console.log("bun async", await child.exited, (await output).trim(), readFileSync("child-dir/shared.txt", "utf8").endsWith("/child-dir"));

const input = Bun.spawn(command.concat(["console.log((await Bun.stdin.text()).toUpperCase())"]), { stdin: "pipe", stdout: "pipe" });
input.stdin.write("hello");
input.stdin.end();
console.log("stdin", (await new Response(input.stdout).text()).trim(), await input.exited);

const nodeSync = spawnSync("bun", ["-e", "console.log('node-sync')"], { encoding: "utf8" });
console.log("node sync", nodeSync.status, nodeSync.stdout.trim(), nodeSync.signal);
const node = spawn(process.argv0, ["-e", "process.stdout.write('node-async')"]);
let text = "";
node.stdout.setEncoding("utf8");
node.stdout.on("data", (part) => { text += part; });
await new Promise((resolve, reject) => { node.on("error", reject); node.on("close", resolve); });
console.log("node async", text, node.exitCode);
console.log("exec sync", execSync("bun -e 'console.log(42)'", { encoding: "utf8" }).trim());
console.log("execFile sync", execFileSync(process.execPath, ["-e", "console.log(43)"], { encoding: "utf8" }).trim());
console.log("exec", (await promisify(exec)("bun -e 'console.log(44)'" )).stdout.trim());
console.log("execFile", (await promisify(execFile)("bun", ["-e", "console.log(45)"])).stdout.trim());
const sleeper = Bun.spawn(command.concat(["setInterval(() => {}, 1000)"]), { stdout: "pipe", stderr: "pipe" });
sleeper.kill("SIGTERM");
console.log("kill", await sleeper.exited, sleeper.signalCode);
console.log("unsupported", Bun.spawnSync(["not-a-bun-command"]).error.code);
const forked = fork("./fork-child.js", ["fork-arg"], { silent: true });
let forkText = "";
forked.stdout.on("data", (chunk) => { forkText += chunk; });
await new Promise((resolve, reject) => { forked.on("error", reject); forked.on("close", resolve); });
console.log("fork", forkText.trim(), forked.exitCode);
try { forked.send("hello"); } catch (error) { console.log("ipc", error.code); }
for (const execute of [execSync, execFileSync]) {
  try { execute("not-a-bun-command"); } catch (error) {
    console.log("exec error", error.code, error.error !== error && typeof JSON.stringify(error) === "string");
  }
}
