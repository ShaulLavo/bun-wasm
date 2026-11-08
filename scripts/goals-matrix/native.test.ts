import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
  expect(cleanup.indexOf("await stopSafariDriver(")).toBeLessThan(cleanup.indexOf("await stopDesktopSafari("));
  expect(cleanup).toContain("state.stopped && state.safariStopped");
  expect(source).toContain("if (config.desktopSafari)");
  const caller = await readFile(new URL("./run.ts", import.meta.url), "utf8");
  expect(caller).toContain('desktopSafari: config.browsers.includes("safari")');
});

function fixture() {
  const state: DesktopSafari = { launchedAfter: null, observed: new Map() };
  let applications: SafariApplication[] = [];
  let now = 10_000;
  const calls: string[] = [];
  const controller = new AbortController();
  const application = { pid: 42, started: now };
  const io: SafariApplicationHost = {
    applications: async () => applications,
    open: async uid => { calls.push(`open:${uid}`); applications = [application]; },
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); now += ms; },
    now: () => now,
    terminate: (pid, kind) => { calls.push(`${kind}:${pid}`); applications = applications.filter(application => application.pid !== pid); },
  };
  return { state, calls, io, controller, application, setApplications: (value: SafariApplication[]) => { applications = value; } };
}
test("a fresh desktop launch gets its GUI startup allowance and owns only the launched PID", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["open:501", "wait:5000"]);
  expect(Array.from(f.state.observed.values())).toEqual([f.application]);
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.at(-1)).toBe("SIGTERM:42");
});
test("an already-running owner Safari is neither opened again nor stopped", async () => {
  const f = fixture();
  f.setApplications([{ pid: 7, started: 1000 }]);
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launchedAfter).toBeNull();
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
  f.io.open = async () => { f.setApplications([f.application]); throw new Error("open failed"); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("open failed");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["SIGTERM:42"]);
});
test("an absent launched app fails setup without starting a driver", async () => {
  const f = fixture();
  f.io.open = async () => {};
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["wait:5000"]);
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
