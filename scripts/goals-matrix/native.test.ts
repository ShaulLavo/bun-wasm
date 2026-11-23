import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDesktopSafari, stopDesktopSafari, parseSafariApplications, parseSafariLaunch, type DesktopSafari, type SafariApplication, type SafariApplicationHost } from "./native-safari";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("native startup prepares Safari after console admission and before starting the driver", async () => {
  const source = await readFile(new URL("./native.ts", import.meta.url), "utf8");
  const consoleCheck = source.indexOf('throw new Error("Desktop Safari requires an unlocked Mac console")');
  const prelaunch = source.indexOf("await io.prepare(");
  const driver = source.indexOf('state.driver = io.spawn(');
  expect(consoleCheck).toBeGreaterThan(-1);
  expect(prelaunch).toBeGreaterThan(consoleCheck);
  expect(driver).toBeGreaterThan(prelaunch);
  const cleanup = source.slice(source.indexOf("async function cleanupNative"));
  expect(cleanup.indexOf("await stopNativeDriver(")).toBeLessThan(cleanup.indexOf("await io.stopApp("));
  expect(cleanup).toContain('admissionOwner: "installed-mac-queue"');
  expect(cleanup).not.toContain("lockRemoved");
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
  const io: SafariApplicationHost = {
    applications: async () => applications,
    launch: async uid => { calls.push(`launch:${uid}`); applications = applications.concat([application]); return application.pid; },
    terminate: (pid, kind) => { calls.push(`${kind}:${pid}`); applications = applications.filter(row => row.pid !== pid); },
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); now += ms; },
    now: () => now,
  };
  return { state, calls, io, controller, application, setApplications: (value: SafariApplication[]) => { applications = value; } };
}
const signals = (calls: string[]) => calls.filter(call => call.startsWith("SIG"));

test("a fresh LaunchServices launch gets its GUI startup allowance and owns only the reported PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["launch:501", "wait:5000"]);
  expect(f.state.launch).toMatchObject({ kind: "owned", application: f.application });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.at(-1)).toBe("SIGTERM:42");
});
test("an already-running owner Safari is neither launched again nor stopped", async () => {
  const f = fixture();
  f.setApplications([{ pid: 7, started: 1000 }]);
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("none");
  expect(f.calls).toEqual([]);
});
test("cancellation during the startup allowance still cleans the task-launched app", async () => {
  const f = fixture();
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "SIGTERM:42"]);
});
test("a failed launch request without a new Safari leaves nothing to stop", async () => {
  const f = fixture();
  f.io.launch = async () => { throw new Error("osascript failed"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("osascript failed");
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("requested");
  expect(signals(f.calls)).toEqual([]);
});
test("a failed launch request that still produced a Safari keeps cleanup unproved", async () => {
  const f = fixture();
  f.io.launch = async () => { f.setApplications([f.application]); throw new Error("osascript timed out"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("osascript timed out");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  expect(signals(f.calls)).toEqual([]);
});
test("an absent reported app fails setup without starting a driver", async () => {
  const f = fixture();
  f.io.launch = async () => 42;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(signals(f.calls)).toEqual([]);
});
test("a reported PID that is not ours keeps cleanup unproved while a new Safari runs", async () => {
  const f = fixture();
  f.io.launch = async () => { f.setApplications([{ pid: 99, started: 10_000 }]); return 42; };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  expect(signals(f.calls)).toEqual([]);
});
test("LaunchServices returning an instance started before the request is never owned", async () => {
  const f = fixture();
  const owner = { pid: 77, started: 9_000 };
  let scans = 0;
  f.io.applications = async () => ++scans === 1 ? [] : [owner];
  f.io.launch = async () => owner.pid;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("reported");
  expect(signals(f.calls)).toEqual([]);
});
test("cleanup never adopts a replacement Safari or a reused PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.setApplications([{ pid: 42, started: 16_000 }, { pid: 99, started: 16_000 }]);
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "wait:5000"]);
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
  f.io.terminate = (pid, kind) => { f.calls.push(`${kind}:${pid}`); };
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  expect(signals(f.calls)).toEqual(["SIGTERM:42", "SIGKILL:42"]);
});
test("process discovery ignores simulator Safari and rejects malformed desktop identities", () => {
  const started = "Sun Nov  8 18:12:41 2026";
  expect(parseSafariApplications(` 42 ${started} /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari\n 7 ${started} /RuntimeRoot/Applications/MobileSafari.app/MobileSafari`)).toEqual([{ pid: 42, started: Date.parse(started) }]);
  expect(() => parseSafariApplications("invalid /Applications/Safari.app/Contents/MacOS/Safari")).toThrow();
  expect(() => parseSafariApplications(` 42 ${"invalid timestamp".padEnd(24)} /Applications/Safari.app/Contents/MacOS/Safari`)).toThrow();
});
test("the LaunchServices report must name one positive PID", () => {
  expect(parseSafariLaunch('{"pid":26592}\n')).toBe(26592);
  for (const output of ['{"pid":0}', '{"pid":-1}', '{"pid":1.5}', '{"pid":"42"}', "{}"]) expect(() => parseSafariLaunch(output)).toThrow("reported no Safari");
  expect(() => parseSafariLaunch("launch failed")).toThrow();
});

test("a replacement launched during the GUI allowance is not adopted", async () => {
  const f = fixture();
  f.io.wait = async () => { f.setApplications([{ pid: 99, started: 16_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501"]);
});

test("owner Safari starting between the snapshot and launch is never signalled", async () => {
  const f = fixture();
  const owner = { pid: 77, started: 9_000 };
  let scans = 0;
  f.io.applications = async () => {
    if (++scans === 1) { f.setApplications([owner]); return []; }
    return [owner];
  };
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io).catch(() => {});
  await stopDesktopSafari(f.state, f.io).catch(() => {});
  expect(f.calls.filter(call => call.endsWith(":77"))).toEqual([]);
});

test("unproved driver shutdown preserves the dependent app and leaves queue ownership alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-driver-order-"));
  try {
    await mkdir(join(root, "tmp/.agent-mac-lock"), { recursive: true });
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
mock.module(source + "/mac-queue.ts", () => ({requireNativeQueue: async () => {}}));
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
  expect(JSON.parse(await readFile(root+"/receipt.json","utf8"))).toMatchObject({driverExited:false,safariExited:false,admissionOwner:"installed-mac-queue"});
} finally {spawn.mockRestore(); if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL"); await driver.exited;}
`;
}

test("cleanup signals only the owned PID when another Safari appears after cancellation", async () => {
  const f = fixture();
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  f.setApplications([f.application, { pid: 99, started: 16_000 }]);
  await stopDesktopSafari(f.state, f.io);
  expect(signals(f.calls)).toEqual(["SIGTERM:42"]);
});

test("desktop Safari launches through LaunchServices, not by executing its binary", async () => {
  // SafariDriver finds its Safari through LaunchServices. A directly executed binary gets a
  // separate record, so a stale record for an automatically terminated Safari wins instead.
  const source = await readFile(new URL("./native-safari.ts", import.meta.url), "utf8");
  expect(source).not.toContain("BUN_WASM_GOALS_SAFARI_OWNER");
  expect(source).not.toContain('"/Applications/Safari.app/Contents/MacOS/Safari"');
  expect(source).toContain("launchApplicationAtURLOptionsConfigurationError");
  expect(source).toContain('"/usr/bin/osascript", "-l", "JavaScript"');
});

test("a second owner Safari during prelaunch blocks the driver without becoming owned", async () => {
  const f = fixture();
  f.io.wait = async () => { f.setApplications([f.application, { pid: 77, started: 10_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("Owner Safari raced");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "SIGTERM:42"]);
});

test("LaunchServices ownership reaps a real task process", async () => {
  const state: DesktopSafari = { launch: { kind: "none" } };
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", env: {} });
  try {
    let application: SafariApplication | undefined;
    const alive = () => application !== undefined && child.exitCode === null && child.signalCode === null;
    const io: SafariApplicationHost = {
      applications: async () => alive() && application ? [application] : [],
      launch: async () => { application = { pid: child.pid, started: Date.now() }; return child.pid; },
      terminate: (pid, kind) => { process.kill(pid, kind); },
      wait: async ms => { await Bun.sleep(Math.min(ms, 50)); },
      now: Date.now,
    };
    await prepareDesktopSafari(state, 501, new AbortController().signal, io);
    expect(state.launch).toMatchObject({ kind: "owned", application });
    await stopDesktopSafari(state, io);
    expect(child.signalCode).toBe("SIGTERM");
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; }
});
