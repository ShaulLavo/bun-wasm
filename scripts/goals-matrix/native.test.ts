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
  let launchToken: string | undefined;
  let applications: SafariApplication[] = [];
  let now = 10_000;
  const calls: string[] = [];
  const controller = new AbortController();
  const application = { pid: 42, started: now };
  const io: SafariApplicationHost = {
    applications: async () => applications,
    open: async (uid, token) => { calls.push(`open:${uid}`); launchToken = token; applications = [application]; },
    owns: async (candidate, token) => token === launchToken && candidate.pid === application.pid && candidate.started === application.started,
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); now += ms; },
    now: () => now,
    terminate: (pid, kind) => { calls.push(`${kind}:${pid}`); applications = applications.filter(application => application.pid !== pid); },
  };
  return { state, calls, io, controller, application, tag: (token: string) => { launchToken = token; }, setApplications: (value: SafariApplication[]) => { applications = value; } };
}
test("a fresh desktop launch gets its GUI startup allowance and owns only the launched PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["open:501", "wait:5000"]);
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
  expect(f.calls).toEqual(["open:501", "SIGTERM:42"]);
});
test("open failure after LaunchServices starts the app still owns cleanup", async () => {
  const f = fixture();
  f.io.open = async (_uid, token) => { f.tag(token); f.setApplications([f.application]); throw new Error("open failed"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("open failed");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["SIGTERM:42"]);
});
test("an absent launched app fails setup without starting a driver", async () => {
  const f = fixture();
  f.io.open = async () => {};
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});
test("cleanup never adopts a replacement Safari or a reused PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.setApplications([{ pid: 42, started: 16_000 }, { pid: 99, started: 16_000 }]);
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["open:501", "wait:5000"]);
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
  f.io.wait = async () => { f.setApplications([{ pid: 99, started: 16_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["open:501"]);
});


test("owner Safari starting between the snapshot and open is never signalled", async () => {
  const f = fixture();
  const owner = { pid: 77, started: 10_000 };
  let scans = 0;
  f.io.applications = async () => {
    if (++scans === 1) { f.setApplications([owner]); return []; }
    return [owner];
  };
  f.io.open = async () => {};
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io).catch(() => {});
  await stopDesktopSafari(f.state, f.io).catch(() => {});
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual([]);
});

test("a pending launch cannot report clean shutdown before the app appears", async () => {
  const f = fixture();
  f.io.open = async () => { throw new Error("open interrupted after handoff"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("open interrupted");
  let scans = 0;
  let running = false;
  f.io.applications = async () => {
    if (++scans >= 2) { running = true; return [f.application]; }
    return [];
  };
  let stopped = false;
  await stopDesktopSafari(f.state, f.io).then(() => { stopped = true; }, () => {});
  expect(stopped && running).toBe(false);
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


test("cleanup settles a delayed marked launch after open reports an error", async () => {
  const f = fixture();
  f.io.open = async (_uid, token) => { f.tag(token); throw new Error("open interrupted after handoff"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("open interrupted");
  let scans = 0;
  let launched = false;
  const current = f.io.applications;
  f.io.applications = async () => {
    if (!launched && ++scans === 2) { launched = true; f.setApplications([f.application]); }
    return current();
  };
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.filter(call => call.startsWith("SIG"))).toEqual(["SIGTERM:42"]);
});
