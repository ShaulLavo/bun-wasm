import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDesktopSafari, stopDesktopSafari, parseSafariApplications, parseSafariReport, helperInstance, type DesktopSafari, type SafariApplication, type SafariApplicationHost, type SafariInstance, type SafariReport } from "./native-safari";

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

// The helper records its request in integer microseconds just before LaunchServices runs.
const requestedUs = 1_795_455_829_721_880n;
function fixture() {
  const state: DesktopSafari = { launch: { kind: "none" } };
  let applications: SafariApplication[] = [];
  const births = new Map<number, bigint>();
  const calls: string[] = [];
  const controller = new AbortController();
  const launched = { pid: 42, bornUs: requestedUs + 43_156n };
  const control: { report: SafariReport; reportHangs: boolean; terminates: boolean; launches: boolean } = {
    report: { kind: "launched", pid: launched.pid, requestedUs }, reportHangs: false, terminates: true, launches: true,
  };
  const instance: SafariInstance = {
    report: () => control.reportHangs ? new Promise(() => {}) : Promise.resolve(control.report),
    own: () => { calls.push("own"); },
    terminate: async () => {
      calls.push("terminate");
      if (!control.terminates) return false;
      births.delete(launched.pid); applications = applications.filter(row => row.pid !== launched.pid);
      return true;
    },
    detach: () => { calls.push("detach"); },
    release: () => { calls.push("release"); },
    exited: Promise.resolve(0),
  };
  const io: SafariApplicationHost = {
    applications: async () => applications,
    birth: async pid => births.get(pid),
    launch: uid => {
      calls.push(`launch:${uid}`);
      if (control.launches) { births.set(launched.pid, launched.bornUs); applications = applications.concat([{ pid: launched.pid, started: 1_795_455_829_000 }]); }
      return instance;
    },
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); },
    limits: { reportMs: 20, terminateMs: 20 },
  };
  const setApplications = (rows: SafariApplication[]) => { applications = rows; };
  // LaunchServices hands back an instance that was already running, born at `bornUs`.
  const returnsExisting = (bornUs: bigint) => {
    control.launches = false;
    control.report = { kind: "launched", pid: 77, requestedUs };
    births.set(77, bornUs);
  };
  return { state, calls, io, controller, launched, control, births, instance, setApplications, returnsExisting };
}
const ownedInstance = (state: DesktopSafari) => {
  if (state.launch.kind !== "owned") throw new Error("Missing owned instance");
  return state.launch.instance;
};

test("a fresh LaunchServices launch is owned, marked to the helper, and terminated through it", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["launch:501", "own", "wait:5000"]);
  expect(f.state.launch).toMatchObject({ kind: "owned", requestedUs, application: f.launched });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.slice(3)).toEqual(["terminate", "release"]);
});
test("an already-running owner Safari is neither launched again nor stopped", async () => {
  const f = fixture();
  f.setApplications([{ pid: 7, started: 1000 }]);
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("none");
  expect(f.calls).toEqual([]);
});
test("an owner Safari started earlier in the request's second is refused", async () => {
  // Round 1 repro: owner at 10.800 s, request at 10.900 s; both floor to the same ps second.
  const f = fixture();
  f.returnsExisting(requestedUs - 100_000n);
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "detach"]);
});
test("an owner Safari born within the request's millisecond is refused at microsecond precision", async () => {
  // Round 2 repro: owner at T + 0.2 ms, request at T + 0.8 ms; a millisecond cutoff floors to T.
  const f = fixture();
  f.returnsExisting(requestedUs - 600n);
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
  expect(f.state.launch).toMatchObject({ kind: "refused", application: { pid: 77, bornUs: requestedUs - 600n } });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "detach"]);
});
test("one microsecond before the helper's request is still refused", async () => {
  const f = fixture();
  f.returnsExisting(requestedUs - 1n);
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
});
test("a Safari the helper finds already running is never launched or owned", async () => {
  const f = fixture();
  f.control.launches = false;
  f.control.report = { kind: "existing" };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("Owner Safari raced");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501"]);
});
test("a reported process that is already gone is refused", async () => {
  const f = fixture();
  f.control.launches = false;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "detach"]);
});
test("an explicit not-launched report leaves nothing to stop", async () => {
  const f = fixture();
  f.control.launches = false;
  f.control.report = { kind: "not-launched" };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("did not launch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501"]);
});
test("a helper lost before its report is always unproved, never a clean exit", async () => {
  const f = fixture();
  f.control.report = { kind: "lost" };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("ended without a report");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("ownership is unproved");
  expect(f.calls).toEqual(["launch:501"]);
});
test("a helper lost after ownership cannot confirm termination and stays unproved", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  ownedInstance(f.state).terminate = async () => { f.calls.push("terminate"); return false; };
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  expect(f.calls.slice(3)).toEqual(["terminate"]);
});
test("a helper that never reports keeps cleanup unproved and is not released", async () => {
  const f = fixture();
  f.control.reportHangs = true;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("timed out");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  expect(f.calls).toEqual(["launch:501"]);
});
test("cancellation during the startup allowance still terminates the owned instance", async () => {
  const f = fixture();
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "own", "terminate", "release"]);
});
test("cancellation while the report is pending lets cleanup attribute and terminate the instance", async () => {
  const f = fixture();
  const report = Promise.withResolvers<SafariReport>();
  f.instance.report = () => report.promise;
  await expect(prepareDesktopSafari(f.state, 501, new AbortController().signal, { ...f.io, limits: { reportMs: 5, terminateMs: 20 } })).rejects.toThrow("timed out");
  report.resolve({ kind: "launched", pid: 42, requestedUs });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "terminate", "release"]);
});
test("startup cancellation before launch leaves owner resources alone", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual([]);
});
test("an instance that does not confirm termination keeps its helper unreleased", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.control.terminates = false;
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  expect(f.calls.slice(3)).toEqual(["terminate"]);
});
test("AppKit termination while the original process still exists keeps the helper unreleased", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  ownedInstance(f.state).terminate = async () => { f.calls.push("terminate"); return true; };
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  expect(f.calls.slice(3)).toEqual(["terminate"]);
});
test("a reused PID after termination is not treated as the instance", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  ownedInstance(f.state).terminate = async () => { f.calls.push("terminate"); f.births.set(42, requestedUs + 9_000_000n); return true; };
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.slice(3)).toEqual(["terminate", "release"]);
});
test("a PID reused during the GUI allowance fails setup and terminates only through the instance", async () => {
  const f = fixture();
  f.io.wait = async () => { f.births.set(42, requestedUs + 6_000_000n); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  ownedInstance(f.state).terminate = async () => { f.calls.push("terminate"); f.births.delete(42); return true; };
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "own", "terminate", "release"]);
});
test("a second owner Safari during prelaunch blocks the driver without becoming owned", async () => {
  const f = fixture();
  f.io.wait = async () => { f.setApplications([{ pid: 42, started: 1 }, { pid: 77, started: 1 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("Owner Safari raced");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "own", "terminate", "release"]);
});
test("process discovery ignores simulator Safari and rejects malformed desktop identities", () => {
  const started = "Sun Nov  8 18:12:41 2026";
  expect(parseSafariApplications(` 42 ${started} /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari\n 7 ${started} /RuntimeRoot/Applications/MobileSafari.app/MobileSafari`)).toEqual([{ pid: 42, started: Date.parse(started) }]);
  expect(() => parseSafariApplications("invalid /Applications/Safari.app/Contents/MacOS/Safari")).toThrow();
  expect(() => parseSafariApplications(` 42 ${"invalid timestamp".padEnd(24)} /Applications/Safari.app/Contents/MacOS/Safari`)).toThrow();
});
test("helper reports keep launched, not-launched, existing and lost distinct", () => {
  expect(parseSafariReport('{"kind":"launched","pid":26592,"requestedUs":1795455829721880}')).toEqual({ kind: "launched", pid: 26592, requestedUs });
  expect(parseSafariReport('{"kind":"not-launched"}')).toEqual({ kind: "not-launched" });
  expect(parseSafariReport('{"kind":"existing"}')).toEqual({ kind: "existing" });
  expect(parseSafariReport(undefined)).toEqual({ kind: "lost" });
  for (const line of ['{"kind":"launched","pid":0,"requestedUs":1}', '{"kind":"launched","pid":42}', '{"kind":"launched","pid":42,"requestedUs":1.5}']) expect(() => parseSafariReport(line)).toThrow("invalid");
  for (const line of ['{"error":"x"}', '{"kind":"other"}', "null"]) expect(() => parseSafariReport(line)).toThrow("Invalid LaunchServices helper report");
});

// A stand-in helper process speaking the osascript helper's line protocol.
const fakeHelper = `
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
out({ kind: "launched", pid: 4242, requestedUs: 1795455829721880 });
let buffered = "";
process.stdin.on("data", chunk => {
  buffered += chunk;
  if (buffered.includes("detach")) process.exit(3);
  if (buffered.includes("release")) process.exit(0);
  if (buffered.includes("terminate")) { buffered = ""; out({ terminated: true }); }
});
`;
test("the retained helper reports, confirms termination and exits on release", async () => {
  const instance = helperInstance([process.execPath, "-e", fakeHelper]);
  expect(await instance.report()).toEqual({ kind: "launched", pid: 4242, requestedUs });
  instance.own();
  expect(await instance.terminate()).toBe(true);
  instance.release();
  expect(await instance.exited).toBe(0);
});
test("a detached helper ends without a termination request", async () => {
  const instance = helperInstance([process.execPath, "-e", fakeHelper]);
  expect((await instance.report()).kind).toBe("launched");
  instance.detach();
  expect(await instance.exited).toBe(3);
});
test("a crashed helper is reported lost and cannot confirm termination", async () => {
  const instance = helperInstance([process.execPath, "-e", "process.exit(9)"]);
  expect(await instance.report()).toEqual({ kind: "lost" });
  expect(await instance.terminate()).toBe(false);
  expect(await instance.exited).toBe(9);
});
test("a helper that dies after its report cannot confirm termination", async () => {
  const instance = helperInstance([process.execPath, "-e", "process.stdout.write(JSON.stringify({ kind: 'launched', pid: 4242, requestedUs: 1 }) + '\\n'); process.exit(9)"]);
  expect((await instance.report()).kind).toBe("launched");
  expect(await instance.terminate()).toBe(false);
});

test("desktop Safari launches through a signal-ignoring LaunchServices helper and never signals a raw PID", async () => {
  // SafariDriver finds its Safari through LaunchServices. A directly executed binary gets a
  // separate record, so a stale record for an automatically terminated Safari wins instead.
  const source = await readFile(new URL("./native-safari.ts", import.meta.url), "utf8");
  expect(source).not.toContain("BUN_WASM_GOALS_SAFARI_OWNER");
  expect(source).not.toContain('"/Applications/Safari.app/Contents/MacOS/Safari"');
  expect(source).not.toContain("process.kill");
  expect(source).toContain("launchApplicationAtURLOptionsConfigurationError");
  expect(source).toContain('runningApplicationsWithBundleIdentifier("com.apple.Safari")');
  expect(source).toContain("app.forceTerminate");
  expect(source).toContain(`'trap "" TERM INT; exec /usr/bin/osascript -l JavaScript -e "$0"'`);
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
