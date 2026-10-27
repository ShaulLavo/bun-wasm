function check(value: unknown, label: string) { if (!value) throw new Error(label); }
const command = (source: string) => [process.execPath, "-e", source];
for (const spawn of [Bun.spawn, Bun.spawnSync]) {
  let rejected = false;
  try {
    spawn(command("setInterval(() => {}, 1000)"), {
      stdin: { _bytes() { throw new Error("invalid-input"); } } as never,
    });
  } catch (error) { rejected = (error as Error).message === "invalid-input"; }
  check(rejected, "invalid stdin conversion did not throw before launch");
}
console.log("invalid stdin rejected before launch");
const sync = Bun.spawnSync(command('require("node:fs").closeSync(0); console.log("out"); console.error("err"); await Bun.sleep(10); process.exit(23);'), {
  stdin: new Uint8Array(512 * 1024), stdout: "pipe", stderr: "pipe", timeout: 5000,
});
check(sync.exitCode === 23 && sync.signalCode === null, "stdin EPIPE replaced exit");
check(new TextDecoder().decode(sync.stdout) === "out\n", "stdin EPIPE lost stdout");
check(new TextDecoder().decode(sync.stderr) === "err\n", "stdin EPIPE lost stderr");
console.log("synchronous stdin EPIPE preserves output and exit");
const { spawn } = await import("node:child_process");
const child = spawn(process.execPath, ["-e", 'require("node:fs").readFileSync(0,"utf8"); console.log("EOF");']);
let output = "";
child.stdout!.on("data", chunk => { output += chunk; });
const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
child.stdin!.destroy();
check(await closed === 0 && output === "EOF\n", "destroy did not deliver stdin EOF");
console.log("Node stdin destroy delivers EOF");
