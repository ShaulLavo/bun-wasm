// Output a child wrote before exiting reaches the parent's streams before its exit event.
import { spawn } from "node:child_process";

function run(label: string, source: string) {
  return new Promise<void>(resolve => {
    const child = spawn(process.execPath, ["-e", source]);
    let stdout = "";
    let stderr = "";
    let exitCodeDuringData: number | null = null;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      exitCodeDuringData ??= child.exitCode;
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", code => {
      console.log(label, "exit", code, "stdout", stdout.length, "stderr", stderr.length, "exitCode during data", exitCodeDuringData);
    });
    child.on("close", () => resolve());
  });
}

await run("small", "process.stdout.write('hello, world!\\n')");
await run("both", "process.stdout.write('out\\n'); process.stderr.write('err\\n')");
await run("large", "process.stdout.write('x'.repeat(200000))");
