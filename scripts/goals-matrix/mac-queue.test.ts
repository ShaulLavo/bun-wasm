import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { options } from "./run";
import { cleanupStaging, nativeRunnerArgs, removeStaging } from "./fleet";
import { admission, queuedNativeCommand, nativeQueueScript, quote } from "./mac-queue";

const installedQueue = join(homedir(), ".agents/skills/machine-fleet/scripts/mac-queue.ts");
const installedTest = test.skipIf(!existsSync(installedQueue));
const threadId = "thread:delegated-task:command%3Amcp%3A74cab812-b487-4145-b97f-591b6205c99a%3Adelegate-task%3Ac4657b58-42ba-4a3a-bd50-5e343f76b641";
const identity = ["--mac-lane=quickjs-safari", `--mac-thread=${threadId}`];
const config = () => options(["--asset-source=packet's identity", "--browsers=safari", "--engines=quickjs", "--frameworks=next,nuxt,astro", "--timeout-ms=90000"].concat(identity));

test("native admission requires explicit lane and actual T3 thread identity", () => {
  expect(() => queuedNativeCommand(options(["--asset-source=test"]), ["bun", "run.js"], "task")).toThrow("lane");
  expect(() => admission(options(["--asset-source=test", "--mac-lane=lane", "--mac-thread="]))).toThrow("T3 thread ID");
  expect(admission(config())).toEqual({ lane: "quickjs-safari", thread: threadId, expectedSeconds: 600, waitSeconds: 3600, timeoutSeconds: 900 });
});
test.each([
  "mcp:0d4397e9-4028-43c4-8183-4d9dfb64821f",
  "thread:delegated-task:command%3Amcp%3A74cab812-b487-4145-b97f-591b6205c99a%3Adelegate-task%3Ac4657b58-42ba-4a3a-bd50-5e343f76b641",
])("opaque T3 thread identity is forwarded unchanged: %s", thread => {
  const request = options(["--asset-source=test", "--mac-lane=quickjs-safari", `--mac-thread=${thread}`]);
  expect(admission(request).thread).toBe(thread);
  const command = queuedNativeCommand(request, ["bun", "run.js"], "task");
  expect(command[command.indexOf("--thread") + 1]).toBe(thread);
  expect(options(nativeRunnerArgs(request, "/Users/fixture/task")).nativeAdmission?.thread).toBe(thread);
});
test.each(["", "   ", "line\nbreak", "line\rbreak", "null\0byte", "x".repeat(1025)])("rejects malformed queue thread text %j", thread => {
  const original = config();
  expect(() => admission({ ...original, nativeAdmission: { ...admission(original), thread } })).toThrow("T3 thread ID");
  expect(() => admission(options(["--asset-source=test", "--mac-lane=lane", `--mac-thread=${thread}`]))).toThrow();
});
test.each(["0", "-1", "1.5", "NaN", "604801"])("rejects invalid queue limits %s without changing phase budgets", value => {
  expect(() => options(["--asset-source=test", `--mac-timeout-seconds=${value}`])).toThrow();
});
test("installed command keeps argv and metadata distinct and never bundles the queue", () => {
  const command = queuedNativeCommand(config(), ["bun", "space ' and $HOME", "--frameworks=next,nuxt,astro"], "nine-cell job", "/Users/fixture home");
  expect(command).toEqual(["/Users/fixture home/.bun/bin/bun", "/Users/fixture home/.agents/skills/machine-fleet/scripts/mac-queue.ts", "run", "--lane", "quickjs-safari", "--thread", threadId, "--task", "nine-cell job", "--expected-seconds", "600", "--wait-seconds", "3600", "--timeout-seconds", "900", "--", "bun", "space ' and $HOME", "--frameworks=next,nuxt,astro"]);
  const forwarded = options(nativeRunnerArgs(config(), "/Users/fixture home/task's dir"));
  expect(forwarded).toMatchObject({ timeoutMs: 90000, installTimeouts: {}, frameworks: ["next", "nuxt", "astro"], browsers: ["safari"], engines: ["quickjs"], nativeAdmission: admission(config()) });
});

type Fixture = { home: string; remote: string; events: string; env: NodeJS.ProcessEnv };
async function fixture(operation: (fixture: Fixture) => Promise<void>, provider?: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-mac-queue-"));
  const home = join(root, "home ' quoted"), remote = join(root, "staging ' quoted");
  try {
    await mkdir(join(home, ".bun/bin"), { recursive: true });
    await mkdir(join(home, ".agents/skills/machine-fleet"), { recursive: true });
    const scripts = join(home, ".agents/skills/machine-fleet/scripts");
    await mkdir(scripts);
    if (provider === undefined) {
      await symlink(installedQueue, join(scripts, "mac-queue.ts"));
      await symlink(join(dirname(installedQueue), "availability.py"), join(scripts, "availability.py"));
    }
    else await writeFile(join(scripts, "mac-queue.ts"), provider);
    await writeFile(join(home, ".bun/bin/bun"), `#!/bin/sh\nif [ "$1" = install ]; then printf 'install\\n' >> "$EVENTS"; exit 0; fi\nexec ${quote(process.execPath)} "$@"\n`);
    await chmod(join(home, ".bun/bin/bun"), 0o755);
    await mkdir(remote);
    await operation({ home, remote, events: join(root, "events"), env: { ...process.env, HOME: home, EVENTS: join(root, "events"), MACHINE_FLEET_STATE_DIR: join(home, ".local/state/machine-fleet") } });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function queueStatus(f: Fixture): Promise<{ holder: unknown; waiting: unknown[] }> {
  const child = Bun.spawn([join(f.home, ".bun/bin/bun"), join(f.home, ".agents/skills/machine-fleet/scripts/mac-queue.ts"), "status"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(text);
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Fixture checkpoint missing");
    await Bun.sleep(20);
  }
}
async function childResult(child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>): Promise<number> {
  const text = new Response(child.stderr).text();
  await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) expect(await text).not.toContain("Cannot find module");
  return code;
}

installedTest.each([0, 7])("real installed queue forwards workload exit %i after cleanup and shell quoting", code => fixture(async f => {
  await writeFile(join(f.remote, "run.js"), `import {appendFile} from 'node:fs/promises'; await appendFile(process.env.EVENTS, JSON.stringify(process.argv.slice(2))+'\\n'); process.exitCode=${code};`);
  const args = nativeRunnerArgs(config(), f.remote);
  const script = nativeQueueScript(config(), f.remote, f.home, args);
  const child = Bun.spawn(["/bin/sh", "-c", script.replaceAll('"/bin/zsh"', '"/bin/sh"').replaceAll("'/bin/zsh'", "'/bin/sh'")], { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await childResult(child)).toBe(code);
  expect(await readFile(join(f.remote, "queue-exit"), "utf8")).toBe(`${code}\n`);
  const events = (await readFile(f.events, "utf8")).trim().split("\n");
  expect(events[0]).toBe("install");
  expect(JSON.parse(events[1] ?? "")).toEqual(args);
  expect(await queueStatus(f)).toMatchObject({ holder: null, waiting: [] });
}), 15000);

installedTest("pre-admission cancellation withdraws only its ticket and preserves an unknown lock", () => fixture(async f => {
  const lock = join(f.home, "tmp/.agent-mac-lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), "unknown owner\n");
  const child = Bun.spawn(queuedNativeCommand(config(), [process.execPath, "-e", "throw Error('must not run')"], "waiting fixture", f.home), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    await waitFor(async () => (await queueStatus(f)).waiting.length === 1);
    child.kill("SIGTERM");
    expect(await childResult(child)).toBe(75);
    expect(await queueStatus(f)).toMatchObject({ holder: null, waiting: [] });
    expect(await readFile(join(lock, "owner"), "utf8")).toBe("unknown owner\n");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}), 15000);

installedTest("timeout stops task descendants before installed queue release", () => fixture(async f => {
  const request = { ...config(), nativeAdmission: { ...admission(config()), timeoutSeconds: 1 } };
  const workload = `import {writeFile} from 'node:fs/promises'; const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'}); await writeFile(process.env.EVENTS,JSON.stringify([process.pid,child.pid])); await Bun.sleep(30000);`;
  const child = Bun.spawn(queuedNativeCommand(request, [process.execPath, "-e", workload], "timeout fixture", f.home), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    expect(await childResult(child)).toBe(124);
    const pids: number[] = JSON.parse(await readFile(f.events, "utf8"));
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(await queueStatus(f)).toMatchObject({ holder: null, waiting: [] });
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}), 15000);

async function delayedAcknowledgement(f: Fixture, empty: boolean, entered: string): Promise<void> {
  await mkdir(join(f.remote, "report"));
  await writeFile(join(f.remote, "queue-workload-started"), "started");
  await writeFile(join(f.remote, "report/native-cleanup.json"), JSON.stringify({ driverExited: true, safariExited: true, admissionOwner: "installed-mac-queue" }));
  if (empty) await writeFile(join(f.remote, "queue-exit"), "");
  let settled = false;
  const cleanup = cleanupStaging(f.remote, true, { ...config(), output: f.home }, new Error("controller cancelled")).then(
    () => { settled = true; return { ok: true }; },
    error => { settled = true; return { ok: false, error: String(error) }; },
  );
  try {
    await waitFor(() => Bun.file(entered).exists());
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(await Bun.file(join(f.remote, "queue-workload-started")).exists()).toBe(true);
    await writeFile(join(f.remote, "queue-exit"), "130\n");
    expect(await cleanup).toEqual({ ok: true });
    expect(await Bun.file(join(f.remote, "queue-workload-started")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(f.home, "fleet-cleanup.json"), "utf8"))).toMatchObject({ stagingRemoved: true, consumersStopped: true });
  } finally {
    if (await Bun.file(join(f.remote, "queue-workload-started")).exists()) await writeFile(join(f.remote, "queue-exit"), "130\n");
    await cleanup;
  }
}

test.each([false, true])("interrupted fleet waits for the remote queue acknowledgement, initially empty = %j", empty => fixture(f => {
  const entered = join(f.home, "cleanup-entered");
  return localMesh(f, () => delayedAcknowledgement(f, empty, entered), entered);
}, "console.log(JSON.stringify({holder:null,waiting:[]}));"));

async function localMesh(f: Fixture, operation: () => Promise<void>, entered?: string): Promise<void> {
  const previous = process.env.PATH;
  await mkdir(join(f.home, "bin"));
  const mesh = join(f.home, "bin/mesh");
  await writeFile(mesh, `#!/bin/sh\nshift 3\nexport HOME=${quote(f.home)}\nexport MACHINE_FLEET_STATE_DIR=${quote(f.env.MACHINE_FLEET_STATE_DIR ?? "")}\n${entered ? `printf entered > ${quote(entered)}\n` : ""}exec "$@"\n`);
  await chmod(mesh, 0o755);
  process.env.PATH = join(f.home, "bin") + ":" + previous;
  try { await operation(); }
  finally { process.env.PATH = previous; }
}
installedTest("remote staging requires a settled invocation, never just a missing runner PID", () => fixture(f => localMesh(f, async () => {
  const request = { ...config(), output: f.home };
  await expect(removeStaging(f.remote, true, request)).rejects.toThrow("queue-exit");
  expect(await Bun.file(join(f.remote, "queue-exit")).exists()).toBe(false);
  await writeFile(join(f.remote, "queue-exit"), "0\n");
  const child = Bun.spawn(queuedNativeCommand(config(), [process.execPath, "-e", "await Bun.write(process.env.EVENTS, 'started'); await Bun.sleep(30000)"], `bun-wasm goals ${f.remote}`, f.home), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    await waitFor(async () => Boolean((await queueStatus(f)).holder));
    await expect(removeStaging(f.remote, true, request)).rejects.toThrow("shutdown is unproved");
    await waitFor(() => Bun.file(f.events).exists());
    child.kill("SIGTERM");
    expect(await childResult(child)).toBe(130);
    await removeStaging(f.remote, true, request);
    expect(await Bun.file(join(f.remote, "queue-exit")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(f.home, "fleet-cleanup.json"), "utf8"))).toMatchObject({ stagingRemoved: true, consumersStopped: true });
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
})), 15000);

test.each([
  { name: "missing", cleanup: null, accepted: false },
  { name: "failed driver", cleanup: { driverExited: false, safariExited: true, admissionOwner: "installed-mac-queue" }, accepted: false },
  { name: "failed Safari", cleanup: { driverExited: true, safariExited: false, admissionOwner: "installed-mac-queue" }, accepted: false },
  { name: "failed native resources", cleanup: { driverExited: false, safariExited: false, admissionOwner: "installed-mac-queue" }, accepted: false },
  { name: "unproved admission", cleanup: { driverExited: true, safariExited: true, admissionOwner: "legacy" }, accepted: false },
  { name: "proved", cleanup: { driverExited: true, safariExited: true, admissionOwner: "installed-mac-queue" }, accepted: true },
])("settled queue keeps native teardown independent: $name", ({ cleanup, accepted }) => fixture(f => localMesh(f, async () => {
  await mkdir(join(f.remote, "report"));
  await writeFile(join(f.remote, "queue-exit"), "1\n");
  await writeFile(join(f.remote, "queue-workload-started"), "started\n");
  if (cleanup) await writeFile(join(f.remote, "report/native-cleanup.json"), JSON.stringify(cleanup));
  const request = { ...config(), output: f.home };
  if (accepted) {
    await removeStaging(f.remote, true, request);
    expect(await Bun.file(join(f.remote, "queue-exit")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(f.home, "fleet-cleanup.json"), "utf8"))).toMatchObject({ stagingRemoved: true, consumersStopped: true });
    return;
  }
  await expect(removeStaging(f.remote, true, request)).rejects.toThrow("native shutdown is unproved");
  expect(await Bun.file(join(f.remote, "queue-exit")).exists()).toBe(true);
  expect(await Bun.file(join(f.home, "fleet-cleanup.json")).exists()).toBe(false);
}), "console.log(JSON.stringify({holder:null,waiting:[]}));"));

installedTest.each([false, true])("native teardown completes inside admission after operation failure %j", fail => fixture(async f => {
  const control = join(f.remote, "native-control.ts");
  await writeFile(control, nativeControl(f, fail));
  const child = Bun.spawn(queuedNativeCommand({ ...config(), nativeAdmission: { ...admission(config()), timeoutSeconds: 3 } }, [process.execPath, control], "native lifecycle fixture", f.home), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await childResult(child);
  expect(code).toBe(fail ? 7 : 0);
  expect((await readFile(f.events, "utf8")).trim().split("\n")).toEqual(["session-stop:held", "server-stop:held", "driver-stop:held", "safari-stop:held"]);
  const receipt = JSON.parse(await readFile(join(f.remote, "native-cleanup.json"), "utf8"));
  expect(receipt).toMatchObject({ driverExited: true, safariExited: true, admissionOwner: "installed-mac-queue" });
  expect(receipt).not.toHaveProperty("lockRemoved");
  expect(await queueStatus(f)).toMatchObject({ holder: null, waiting: [] });
}), 15000);
function nativeControl(f: Fixture, fail: boolean): string {
  return `import {mock,spyOn} from 'bun:test';
import {appendFile,stat} from 'node:fs/promises';
const source=${JSON.stringify(import.meta.dir)};
const event=async name=>{await stat(${JSON.stringify(join(f.home, "tmp/.agent-mac-lock"))});await appendFile(process.env.EVENTS,name+':held\\n');};
const lifetime=await import(source+'/lifetime.ts');
const ownedCommand=lifetime.ownedCommand;
mock.module(source+'/lifetime.ts',()=>({...lifetime,ownedCommand:(args,...rest)=>args[0]==='ioreg'?Promise.resolve(''):ownedCommand(args,...rest)}));
const original=Bun.spawn.bind(Bun);
let driver;
const spawn=spyOn(Bun,'spawn').mockImplementation((args,options)=>{if(args.includes('/usr/bin/safaridriver')){driver=original([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});return driver;}return original(args,options);});
mock.module(source+'/../../web/tests/engine-interruption-safari.ts',()=>({allocateSafariDriverPort:async()=>12345,ownSafariDriver:child=>child,stopSafariDriver:async child=>{child.kill('SIGTERM');await child.exited;await event('driver-stop');}}));
mock.module(source+'/native-safari.ts',()=>({prepareDesktopSafari:async()=>{},stopDesktopSafari:async()=>{if(driver.exitCode===null&&driver.signalCode===null)throw Error('driver still live');await event('safari-stop');}}));
mock.module(source+'/playground.ts',()=>({until:async()=>true}));
Object.defineProperty(process,'platform',{value:'darwin'});
const {withNativeDriver}=await import(source+'/native.ts');
async function operation(){const server=original([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});try{if(${fail})throw Error('operation failed');}finally{await event('session-stop');server.kill('SIGTERM');await server.exited;await event('server-stop');}}
try{await withNativeDriver(operation,{desktopSafari:true,cleanupFile:${JSON.stringify(join(f.remote, "native-cleanup.json"))}});}catch(error){if(error.message!=='operation failed')throw error;process.exitCode=7;}finally{spawn.mockRestore();if(driver&&driver.exitCode===null&&driver.signalCode===null){driver.kill('SIGKILL');await driver.exited;}}
`;
}

installedTest("remote wait cancellation writes a settled result without consuming staging", () => fixture(f => localMesh(f, async () => {
  const lock = join(f.home, "tmp/.agent-mac-lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), "unknown owner\n");
  const script = nativeQueueScript(config(), f.remote, f.home, []).replaceAll("'/bin/zsh'", "'/bin/sh'");
  const child = Bun.spawn(["/bin/sh", "-c", script], { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    await waitFor(async () => (await queueStatus(f)).waiting.length === 1);
    child.kill("SIGTERM");
    expect(await childResult(child)).toBe(75);
    expect(await readFile(join(f.remote, "queue-exit"), "utf8")).toBe("75\n");
    await removeStaging(f.remote, true, { ...config(), output: f.home });
    expect(await readFile(join(lock, "owner"), "utf8")).toBe("unknown owner\n");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
})), 15000);

installedTest("owner-busy and wait expiry leave owner state untouched", () => fixture(async f => {
  const busy = join(f.env.MACHINE_FLEET_STATE_DIR ?? "", "owner-busy");
  await mkdir(join(f.home, ".local/state/machine-fleet"), { recursive: true });
  await writeFile(busy, "owner working\n");
  const request = { ...config(), nativeAdmission: { ...admission(config()), waitSeconds: 1 } };
  const child = Bun.spawn(queuedNativeCommand(request, [process.execPath, "-e", "throw Error('must not run')"], "owner busy fixture", f.home), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await childResult(child)).toBe(75);
  expect(await readFile(busy, "utf8")).toBe("owner working\n");
  expect(await queueStatus(f)).toMatchObject({ holder: null, waiting: [] });
}), 15000);

test.each([0, 7, 75, 124, 130])("injected installed CLI forwards exit %i without a legacy admission fallback", code => fixture(async f => {
  const controller = join(f.remote, "controller.ts");
  await writeFile(controller, `import {runQueuedNative} from ${JSON.stringify(join(import.meta.dir, "mac-queue.ts"))}; process.exitCode=await runQueuedNative(${JSON.stringify(config())},['fixture workload','quoted arg'], 'bounded task');`);
  const child = Bun.spawn([process.execPath, controller], { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await childResult(child)).toBe(code);
  expect(JSON.parse(await readFile(f.events, "utf8"))).toEqual(queuedNativeCommand(config(), ["fixture workload", "quoted arg"], "bounded task", f.home).slice(2));
}, `await Bun.write(process.env.EVENTS,JSON.stringify(process.argv.slice(2)));process.exitCode=${code};`));

test("controller cancellation waits for the installed CLI to settle", () => fixture(async f => {
  const controller = join(f.remote, "controller.ts");
  await writeFile(controller, `import {runQueuedNative} from ${JSON.stringify(join(import.meta.dir, "mac-queue.ts"))}; process.exitCode=await runQueuedNative(${JSON.stringify(config())},['fixture workload'], 'cancelled task');`);
  const child = Bun.spawn([process.execPath, controller], { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    await waitFor(() => Bun.file(f.events).exists());
    child.kill("SIGTERM");
    expect(await childResult(child)).toBe(75);
    expect(await readFile(f.events, "utf8")).toBe("settled\n");
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}, `process.on('SIGTERM',async()=>{await Bun.sleep(50);await Bun.write(process.env.EVENTS,'settled\\n');process.exit(75);});await Bun.write(process.env.EVENTS,'waiting');setInterval(()=>{},1000);`), 10000);

test.each([false, true])("direct Mac CLI uses the same admission route with an explicit endpoint %j", endpoint => fixture(async f => {
  const preload = join(f.remote, "darwin.ts");
  await writeFile(preload, "Object.defineProperty(process,'platform',{value:'darwin'});");
  const args = nativeRunnerArgs(config(), f.remote).concat(endpoint ? ["--safari-endpoint=http://127.0.0.1:12345"] : []);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "run.ts")].concat(args), { env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await childResult(child)).toBe(75);
  const called: string[] = JSON.parse(await readFile(f.events, "utf8"));
  expect(called.slice(0, 13)).toEqual(queuedNativeCommand(config(), [], `bun-wasm goals ${f.remote}/report`, f.home).slice(2, 15));
  expect(called.slice(-args.length)).toEqual(args);
}, `if(process.argv[2]==='status')console.log(JSON.stringify({holder:null,waiting:[]}));else{await Bun.write(process.env.EVENTS,JSON.stringify(process.argv.slice(2)));process.exitCode=75;}`));
