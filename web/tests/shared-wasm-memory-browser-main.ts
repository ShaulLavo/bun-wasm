// Real shared-group guest on the production Browser host: startRun, Waffle's broker and worker.
import { createRuntime } from "waffle";
import { prepareProgram } from "../../src/assets.ts";
import { startRun } from "../src/runner";

const FIXTURE = "/home/user/fixture";

async function bytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${url} ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function run() {
  if (!crossOriginIsolated) throw new Error("A memory group requires a cross-origin isolated page");
  const manifest: unknown = await (await fetch("./fixture/index.json")).json();
  if (!Array.isArray(manifest)) throw new Error("Invalid fixture manifest");
  const names = manifest.map(String);
  const entry = new URLSearchParams(location.search).get("entry") ?? "browser-guest.ts";
  // The Bun group core declares a 1 GiB maximum and an 8 MiB member stack (docs/shared-group-profile.md).
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
    memoryGroups: { maximumPages: 16384, stackBytes: 8 << 20 },
  });
  await runtime.filesystem.mkdirp(FIXTURE);
  for (const name of names) await runtime.filesystem.writeFile(`${FIXTURE}/${name}`, await bytes(`./fixture/${name}`));
  await runtime.filesystem.flush();
  const module = await prepareProgram({ kind: "quickjs", core: await bytes("./program/bun.wasm"), side: await bytes("./program/quickjs.wasm") });
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const started = performance.now();
  const job = startRun({
    runtime, module, engine: "quickjs", moduleScope: false,
    args: ["run", `${FIXTURE}/${entry}`],
    env: { PWD: FIXTURE, HOME: "/home/user", PATH: "/bin:/usr/bin" },
  }, {
    stdout(data) { stdout += decoder.decode(data, { stream: true }); },
    stderr(data) { stderr += decoder.decode(data, { stream: true }); },
  });
  // Owner-side counters while members live: proof real regions were reserved and charged.
  const processes = await runtime.processes();
  const peak = { groups: 0, regions: 0, holds: 0, committedBytes: 0 };
  const sampling = setInterval(() => {
    const groups = processes.memoryGroups();
    peak.groups = Math.max(peak.groups, groups.length);
    peak.regions = Math.max(peak.regions, groups.reduce((sum, group) => sum + group.regions, 0));
    peak.holds = Math.max(peak.holds, groups.reduce((sum, group) => sum + group.holds, 0));
    peak.committedBytes = Math.max(peak.committedBytes, groups.reduce((sum, group) => sum + group.committedBytes, 0));
  }, 1);
  const result = await job.done;
  clearInterval(sampling);
  const wallMs = performance.now() - started;
  // The broker releases a member only after its physical stop, which trails run.done.
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && processes.memoryGroups().some(group => group.members > 0 || group.retained > 0)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { ...result, wallMs, stdout, stderr, peak, groups: processes.memoryGroups() };
}

void run().then(
  value => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, ...value }),
  (error: unknown) => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, thrown: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }),
);
