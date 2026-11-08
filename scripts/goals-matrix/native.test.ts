import { expect, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDesktopSafari, stopDesktopSafari, parseSafariApplications, type DesktopSafari, type SafariApplication, type SafariApplicationHost } from "./native-safari";

test("native startup prepares Safari after console admission and before starting the driver", async () => {
  const source = await readFile(new URL("./native.ts", import.meta.url), "utf8");
  const consoleCheck = source.indexOf('throw new Error("Desktop Safari requires an unlocked Mac console")');
  const prelaunch = source.indexOf("await prepareDesktopSafari(");
  const driver = source.indexOf('"/usr/bin/safaridriver"');
  expect(consoleCheck).toBeGreaterThan(-1);
  expect(prelaunch).toBeGreaterThan(consoleCheck);
  expect(driver).toBeGreaterThan(prelaunch);
  const cleanup = source.slice(source.indexOf("async function cleanupNative"));
  expect(cleanup.indexOf("await stopNativeDriver(")).toBeLessThan(cleanup.indexOf("await stopDesktopSafari("));
  expect(cleanup).toContain("state.stopped && state.safariStopped");
  expect(source).toContain("if (config.desktopSafari)");
  const caller = await readFile(new URL("./run.ts", import.meta.url), "utf8");
  expect(caller).toContain('desktopSafari: config.browsers.includes("safari")');
});

function fixture() {
  const state: DesktopSafari = { launch: { kind: "none" } };
  let applications: SafariApplication[] = [];
  let now = 10_000;
  const calls: string[] = [];
  const controller = new AbortController();
  const application = { pid: 42, started: now };
  let resolveExit: (code: number) => void = () => {};
  let exitCode: number | null = null, signalCode: ReturnType<SafariApplicationHost["spawn"]>["signalCode"] = null;
  const child = {
    pid: 42, get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    exited: new Promise<number>(resolve => { resolveExit = resolve; }),
    kill: (kind: number | NodeJS.Signals = "SIGTERM") => {
      calls.push(`${kind}:42`); applications = applications.filter(application => application.pid !== 42);
      signalCode = kind; resolveExit(0);
    },
  };
  const io: SafariApplicationHost = {
    applications: async () => applications,
    spawn: uid => { calls.push(`spawn:${uid}`); applications = [application]; return child; },
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); now += ms; },
    now: () => now,
  };
  return { state, calls, io, child, controller, application, exit: () => { exitCode = 0; resolveExit(0); }, setApplications: (value: SafariApplication[]) => { applications = value; } };
}
test("a fresh desktop launch gets its GUI startup allowance and owns only the launched PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["spawn:501", "wait:5000"]);
  expect(f.state.launch).toMatchObject({ kind: "owned", application: f.application });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.at(-1)).toBe("SIGTERM:42");
});
test("an already-running owner Safari is neither opened again nor stopped", async () => {
  const f = fixture();
  f.setApplications([{ pid: 7, started: 1000 }]);
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("none");
  expect(f.calls).toEqual([]);
});
test("cancellation during the startup allowance still cleans the task-opened app", async () => {
  const f = fixture();
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["spawn:501", "SIGTERM:42"]);
});
test("a synchronous spawn failure leaves no pending application", async () => {
  const f = fixture();
  f.io.spawn = () => { throw new Error("spawn failed"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("spawn failed");
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("none");
  expect(f.calls).toEqual([]);
});
test("an absent launched app fails setup without starting a driver", async () => {
  const f = fixture();
  f.io.spawn = () => f.child;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});
test("cleanup never adopts a replacement Safari or a reused PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.exit();
  f.setApplications([{ pid: 42, started: 16_000 }, { pid: 99, started: 16_000 }]);
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["spawn:501", "wait:5000"]);
});
test("startup cancellation before launch leaves owner resources alone", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual([]);
});
test("shutdown escalates only the same owned PID and fails when exit is unproved", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.child.kill = (kind = "SIGTERM") => { f.calls.push(`${kind}:42`); };
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual(["SIGTERM:42", "SIGKILL:42"]);
});
test("process discovery ignores simulator Safari and rejects malformed desktop identities", () => {
  const started = "Sun Nov  8 18:12:41 2026";
  expect(parseSafariApplications(` 42 ${started} /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari\n 7 ${started} /RuntimeRoot/Applications/MobileSafari.app/MobileSafari`)).toEqual([{ pid: 42, started: Date.parse(started) }]);
  expect(() => parseSafariApplications("invalid /Applications/Safari.app/Contents/MacOS/Safari")).toThrow();
  expect(() => parseSafariApplications(` 42 ${"invalid timestamp".padEnd(24)} /Applications/Safari.app/Contents/MacOS/Safari`)).toThrow();
});

test("a replacement launched during the GUI allowance is not adopted", async () => {
  const f = fixture();
  f.io.wait = async () => { f.exit(); f.setApplications([{ pid: 99, started: 16_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["spawn:501"]);
});


test("owner Safari starting between the snapshot and spawn is never signalled", async () => {
  const f = fixture();
  const owner = { pid: 77, started: 10_000 };
  let scans = 0;
  f.io.applications = async () => {
    if (++scans === 1) { f.setApplications([owner]); return []; }
    return [owner];
  };
  f.io.spawn = () => f.child;
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io).catch(() => {});
  await stopDesktopSafari(f.state, f.io).catch(() => {});
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});

test("an uncaptured live child cannot report clean shutdown", async () => {
  const f = fixture();
  f.io.spawn = () => f.child;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("ownership is unproved");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});

test("a child that exits before attribution keeps cleanup unproved", async () => {
  const f = fixture();
  f.io.spawn = () => { f.exit(); return f.child; };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("exited before ownership");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});

test("unproved driver shutdown preserves the dependent app and lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-driver-order-"));
  try {
    await mkdir(join(root, "tmp"));
    const script = join(root, "control.ts");
    await writeFile(script, driverFailureControl(root));
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    const [stdout, stderr] = await output;
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);

function driverFailureControl(root: string): string {
  return `import { expect, mock, spyOn } from "bun:test";
import { readFile, stat } from "node:fs/promises";
const root = ${JSON.stringify(root)};
const source = ${JSON.stringify(import.meta.dir)};
const events = [];
const original = await import(source + "/../../web/tests/engine-interruption-safari.ts");
const driver = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout:"ignore",stderr:"ignore"});
const spawn = spyOn(Bun, "spawn").mockReturnValue(driver);
mock.module(source + "/lifetime.ts", () => ({ownedCommand: async () => "", withSignals: async operation => operation(new AbortController().signal)}));
mock.module(source + "/playground.ts", () => ({until: async () => true}));
mock.module(source + "/../../web/tests/engine-interruption-safari.ts", () => ({...original, allocateSafariDriverPort: async () => 12345, stopSafariDriver: async () => {throw new Error("driver shutdown unproved");}}));
mock.module(source + "/native-safari.ts", () => ({prepareDesktopSafari: async () => {}, stopDesktopSafari: async () => {events.push("app-stop");}}));
Object.defineProperty(process, "platform", {value:"darwin"});
try {
  const {withNativeDriver} = await import(source + "/native.ts");
  await expect(withNativeDriver(async () => {}, {desktopSafari:true,cleanupFile:root+"/receipt.json"})).rejects.toThrow("driver shutdown unproved");
  expect(events).toEqual([]);
  expect((await stat(root+"/tmp/.agent-mac-lock")).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(root+"/receipt.json","utf8"))).toMatchObject({driverExited:false,safariExited:false,lockRemoved:false});
} finally {spawn.mockRestore(); if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL"); await driver.exited;}
`;
}


test("cleanup captures only the direct child if cancellation preceded exec", async () => {
  const f = fixture();
  f.io.spawn = () => f.child;
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  f.setApplications([f.application, { pid: 99, started: 16_000 }]);
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual(["SIGTERM:42"]);
});

test("a task-spawned Safari without an environment marker still has positive ownership", async () => {
  const f = fixture();
  // Exact ps eww need not expose an environment marker: ownership is the child.
  const source = await readFile(new URL("./native-safari.ts", import.meta.url), "utf8");
  expect(source).not.toContain("BUN_WASM_GOALS_SAFARI_OWNER");
  expect(source).toContain('"/Applications/Safari.app/Contents/MacOS/Safari"');
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.state.launch).toMatchObject({ kind: "owned", application: f.application });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.at(-1)).toBe("SIGTERM:42");
});


test("a second owner Safari during prelaunch blocks the driver without becoming owned", async () => {
  const f = fixture();
  f.io.wait = async () => { f.setApplications([f.application, { pid: 77, started: 10_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("Owner Safari raced");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["spawn:501", "SIGTERM:42"]);
});


test("a live handle with a changed process birth identity is never signalled", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.setApplications([{ pid: f.child.pid, started: 16_000 }]);
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("ownership is unproved");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});

test("marker-free ownership reaps a real task child", async () => {
  const state: DesktopSafari = { launch: { kind: "none" } };
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", env: {} });
  try {
    const application = { pid: child.pid, started: Date.now() };
    let launched = false;
    const io: SafariApplicationHost = { applications: async () => launched ? [application] : [], spawn: () => { launched = true; return child; }, wait: async () => {}, now: Date.now };
    await prepareDesktopSafari(state, 501, new AbortController().signal, io);
    expect(state.launch).toMatchObject({ kind: "owned", application });
    await stopDesktopSafari(state, io);
    expect(child.signalCode).toBe("SIGTERM");
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; }
});
