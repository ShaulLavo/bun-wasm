// The page behind scripts/embed-browser.test.ts. It imports only the public `bun-wasm` and
// `waffle` exports and runs the example from docs/guides/embed-in-a-page.md.
import { createRuntime } from "waffle";
import { installBunAdapters, runBun, startBun, type BunRunResult } from "bun-wasm";

// A Vite app gets these from `bun-wasm/worker?worker&url` and friends; the test bundles the
// same worker sources under these names.
const workerUrl = "/worker.js";
const notificationWorkerUrl = "/notification-worker.js";
// The documented example omits `asset` and downloads the published guest. The test swaps in
// the guest built from this commit, so it checks that commit rather than the published one.
const asset = await (await fetch("/guest.json")).json();

function summary(result: BunRunResult) {
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, stopped: result.stopped };
}

async function scenarios() {
  // The documented example, line for line apart from `asset`.
  const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
  await installBunAdapters(runtime, { workerUrl, notificationWorkerUrl, asset });
  const { exitCode, stdout } = await runBun(runtime, ["-e", "console.log(Bun.version)"]);

  // Collected output is a pipe, not a terminal: no colour codes around inspected values.
  const inspected = await runBun(runtime, ["-e", "console.log({ a: 1 }); console.error([true]); console.log(process.stdout.isTTY ?? false)"]);
  // Asked for, a terminal is what Bun sees, and it colours inspected values.
  const terminal = await runBun(runtime, ["-e", "console.log(process.stdout.isTTY ?? false)"], { terminal: true });

  await runtime.filesystem.mkdirp("/app");
  await runtime.filesystem.writeFile("/app/index.ts", "const greeting: string = 'hello from TypeScript';\nconsole.log(greeting);\nconsole.error('to stderr');\nprocess.exit(3);\n");
  const typescript = await runBun(runtime, ["index.ts"], { cwd: "/app" });

  await runtime.filesystem.writeFile("/app/math.test.ts", "import { expect, test } from 'bun:test';\ntest('adds', () => { expect(1 + 2).toBe(3); });\n");
  const tests = await runBun(runtime, ["test"], { cwd: "/app" });

  const chunks: string[] = [];
  const stdin = await runBun(runtime, ["-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "piped input\n",
    onStdout: chunk => { chunks.push(new TextDecoder().decode(chunk)); },
  });

  const running = Promise.withResolvers<void>();
  const server = startBun(runtime, ["-e", "setInterval(() => {}, 1000); console.log('running')"], { onStdout: () => running.resolve() });
  await running.promise;
  await server.kill();
  const killed = await server.result;

  await runtime.dispose();
  return {
    example: { exitCode, stdout },
    inspected: summary(inspected),
    terminal: summary(terminal),
    typescript: summary(typescript),
    tests: summary(tests),
    stdin: { ...summary(stdin), chunks: chunks.join("") },
    killed: summary(killed),
  };
}

try {
  Reflect.set(globalThis, "embedResult", { ok: true, ...await scenarios() });
} catch (error) {
  Reflect.set(globalThis, "embedResult", { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
}
