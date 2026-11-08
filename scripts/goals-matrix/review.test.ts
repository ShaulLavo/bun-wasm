import { deadlinePolicy } from "./deadlines";
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialCells, validateReport, finish, phases, type Report } from "./model";
import { assetIdentity } from "./assets";
import { fleet, removeStaging } from "./fleet";
import { options } from "./run";

function report(): Report { return { schema: 2, run: "regression", createdAt: "now", command: "test", deadlines: deadlinePolicy(180_000), source: { commit: "test", dirty: false, assets: {} }, cells: initialCells() }; }
test("external reports reject unknown schemas and statuses, malformed attempts and false phase evidence", () => {
  expect(() => validateReport(JSON.parse(JSON.stringify({ ...report(), schema: 99 })))).toThrow();
  const result = report();
  const external = JSON.parse(JSON.stringify(result));
  external.cells[0].status = "unrecognized";
  expect(() => validateReport(external)).toThrow();
  const attempt = { startedAt: "now", finishedAt: "now", browser: { browserName: "chrome" }, phases: phases.map(phase => ({ phase, status: "pass" as const, startedAt: "now", durationMs: 0, timeoutMs: 180_000, evidence: false })) };
  expect(() => finish({ framework: "next", browser: "chrome", engine: "browser" }, attempt)).toThrow();
});

test("continuation identity changes when executed host or template bytes change", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-identity-"));
  try {
    await writeFile(join(root, "main.js"), "old host");
    await writeFile(join(root, "vite-react.json"), "old template");
    const first = await assetIdentity(root);
    await writeFile(join(root, "main.js"), "new host");
    expect(await assetIdentity(root)).not.toEqual(first);
    const second = await assetIdentity(root);
    await writeFile(join(root, "vite-react.json"), "new template");
    expect(await assetIdentity(root)).not.toEqual(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Chrome-only fleet needs no simulator and never visits the Mac", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-selection-"));
  try {
    const result = await fleet(options([`--root=${root}`, `--output=${root}/report`, "--browsers=chrome", "--frameworks=nuxt", "--engines=browser", "--asset-source=test"]));
    const selected = result.cells.find(cell => cell.framework === "nuxt" && cell.browser === "chrome" && cell.engine === "browser");
    expect(selected?.status).toBe("not runnable yet");
    expect(result.cells.filter(cell => cell.browser !== "chrome").every(cell => cell.status === "pending")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unavailable Mac records native discovery without running unselected Linux browsers", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-mac-discovery-"));
  const previous = process.env.PATH;
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/mesh"), "#!/bin/sh\necho 'fixture Mac unavailable' >&2\nexit 75\n");
    await chmod(join(root, "bin/mesh"), 0o755);
    process.env.PATH = join(root, "bin") + ":" + previous;
    const result = await fleet(options([`--root=${root}`, `--output=${root}/report`, "--browsers=safari", "--frameworks=nuxt", "--engines=browser", "--asset-source=test"]));
    const selected = result.cells.find(cell => cell.framework === "nuxt" && cell.browser === "safari" && cell.engine === "browser");
    expect(selected).toMatchObject({ status: "not runnable yet", attempts: [], discovery: { error: expect.stringContaining("75") } });
    expect(result.cells.filter(cell => cell.browser !== "safari").every(cell => cell.status === "pending")).toBe(true);
  } finally { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); }
});

test("SIGTERM during native lock setup reaps the setup child and releases the owned lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-native-signal-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let setupPid = 0;
  try {
    await mkdir(join(root, ".agents/skills/machine-fleet/scripts"), { recursive: true });
    await mkdir(join(root, "tmp"));
    await writeFile(join(root, ".agents/skills/machine-fleet/scripts/availability.py"), "import os,time\np=os.environ['HOME']+'/called'\nif os.path.exists(p):\n open(os.environ['HOME']+'/second','w').write(str(os.getpid()))\n time.sleep(30)\nelse: open(p,'w').write('called')\n");
    await writeFile(join(root, "child.ts"), `Object.defineProperty(process,'platform',{value:'darwin'}); const {withNativeDriver}=await import(${JSON.stringify(join(import.meta.dir, "native.ts"))}); await withNativeDriver(async()=>{});`);
    child = Bun.spawn([process.execPath, join(root, "child.ts")], { env: { ...process.env, HOME: root }, stdout: "ignore", stderr: "ignore" });
    await waitForFile(join(root, "second"));
    setupPid = Number(await Bun.file(join(root, "second")).text());
    child.kill("SIGTERM");
    await child.exited;
    await expect(access(join(root, "tmp/.agent-mac-lock"))).rejects.toThrow();
    expect(() => process.kill(setupPid, 0)).toThrow();
  } finally { await stopFixture(child, setupPid); await rm(root, { recursive: true, force: true }); }
}, 10_000);

test("staging removal refuses unproved remote shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-remote-cleanup-"));
  const previous = process.env.PATH;
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/mesh"), `#!/bin/sh\ncase "$*" in *"rm -rf"*) touch '${root}/removed';; *) printf '%s' '{"driverExited":false,"lockRemoved":false}';; esac\n`);
    await chmod(join(root, "bin/mesh"), 0o755);
    process.env.PATH = join(root, "bin") + ":" + previous;
    await expect(removeStaging("/Users/fixture/tmp/goals-owned", true, options([`--root=${root}`, `--output=${root}`, "--asset-source=test"]))).rejects.toThrow("shutdown is unproved");
    await expect(access(join(root, "removed"))).rejects.toThrow();
  } finally { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); }
});

test("fleet SIGTERM during Mac discovery reaps its child and releases local ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-fleet-signal-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let meshPid = 0;
  try {
    await mkdir(join(root, "bin")); await mkdir(join(root, "site"));
    await writeFile(join(root, "bin/mesh"), `#!/usr/bin/env python3\nimport os,time\nopen('${root}/mesh-pid','w').write(str(os.getpid()))\ntime.sleep(30)\n`);
    await chmod(join(root, "bin/mesh"), 0o755);
    const args = [`--root=${root}/site`, `--output=${root}/report`, "--browsers=safari", "--engines=browser", "--frameworks=nuxt", "--asset-source=test"];
    child = Bun.spawn([process.execPath, join(import.meta.dir, "fleet.ts")].concat(args), { env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH }, stdout: "ignore", stderr: "ignore" });
    await waitForFile(join(root, "mesh-pid"));
    meshPid = Number(await Bun.file(join(root, "mesh-pid")).text());
    child.kill("SIGTERM"); await child.exited;
    await expect(access(join(root, "report/.goals-fleet-lock"))).rejects.toThrow();
    expect(() => process.kill(meshPid, 0)).toThrow();
  } finally {
    await stopFixture(child, meshPid);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

async function waitForFile(path: string): Promise<void> {
  const end = Date.now() + 4000;
  while (!await Bun.file(path).exists()) { if (Date.now() > end) throw new Error("Fixture did not reach its checkpoint"); await Bun.sleep(10); }
}
async function stopFixture(child: ReturnType<typeof Bun.spawn> | undefined, pid: number): Promise<void> {
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child) await child.exited;
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}
