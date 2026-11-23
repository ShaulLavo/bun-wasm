import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDesktopSafari, stopDesktopSafari, parseSafariApplications, parseSafariReport, helperInstance, type DesktopSafari, type SafariApplication, type SafariApplicationHost, type SafariInstance } from "./native-safari";

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

// The request is made at 10_900 ms. Births carry sub-second precision, unlike ps lstart.
function fixture() {
  const state: DesktopSafari = { launch: { kind: "none" } };
  let applications: SafariApplication[] = [];
  const births = new Map<number, number>();
  let now = 10_900;
  const calls: string[] = [];
  const controller = new AbortController();
  const launched = { pid: 42, born: 10_950.25 };
  const control = { reported: launched.pid as number | undefined, reportHangs: false, terminates: true, launches: true };
  const instance: SafariInstance = {
    report: () => control.reportHangs ? new Promise(() => {}) : Promise.resolve(control.reported),
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
      if (control.launches) { births.set(launched.pid, launched.born); applications = applications.concat([{ pid: launched.pid, started: 10_000 }]); }
      return instance;
    },
    wait: async (ms, signal) => { signal?.throwIfAborted(); calls.push(`wait:${ms}`); now += ms; },
    now: () => now,
    limits: { reportMs: 20, terminateMs: 20 },
  };
  const setApplications = (rows: SafariApplication[]) => { applications = rows; };
  return { state, calls, io, controller, launched, control, births, setApplications };
}

test("a fresh LaunchServices launch gets its GUI startup allowance and owns the reported instance", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  expect(f.calls).toEqual(["launch:501", "wait:5000"]);
  expect(f.state.launch).toMatchObject({ kind: "owned", requested: 10_900, application: f.launched });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.slice(2)).toEqual(["terminate", "release"]);
});
test("an already-running owner Safari is neither launched again nor stopped", async () => {
  const f = fixture();
  f.setApplications([{ pid: 7, started: 1000 }]);
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  await stopDesktopSafari(f.state, f.io);
  expect(f.state.launch.kind).toBe("none");
  expect(f.calls).toEqual([]);
});
test("an owner Safari started earlier in the request's second is refused and never terminated", async () => {
  // Sol's repro: owner born at 10.800 s, request at 10.900 s. Both floor to 10 s in ps lstart.
  const f = fixture();
  f.control.launches = false;
  f.control.reported = 77;
  f.io.launch = uid => { f.calls.push(`launch:${uid}`); f.births.set(77, 10_800); f.setApplications([{ pid: 77, started: 10_000 }]); return fixtureInstance(f); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
  expect(f.state.launch).toMatchObject({ kind: "refused", application: { pid: 77, born: 10_800 } });
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "detach"]);
});
function fixtureInstance(f: ReturnType<typeof fixture>): SafariInstance {
  return { report: async () => f.control.reported, terminate: async () => { f.calls.push("terminate"); return true; }, detach: () => { f.calls.push("detach"); }, release: () => { f.calls.push("release"); }, exited: Promise.resolve(0) };
}
test("a reported process that is already gone is refused", async () => {
  const f = fixture();
  f.control.launches = false;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("refusing ownership");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "detach"]);
});
test("cancellation during the startup allowance still terminates the owned instance", async () => {
  const f = fixture();
  f.io.wait = async (_ms, signal) => { f.controller.abort(); signal?.throwIfAborted(); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow();
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "terminate", "release"]);
});
test("a helper that reports no launch leaves nothing to stop", async () => {
  const f = fixture();
  f.control.launches = false;
  f.control.reported = undefined;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("did not launch");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501"]);
});
test("a helper that never reports keeps cleanup unproved and is not released", async () => {
  const f = fixture();
  f.control.reportHangs = true;
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("timed out");
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("launch ownership is unproved");
  // The helper keeps the queue's process group occupied while its launch is undecided.
  expect(f.calls).toEqual(["launch:501"]);
});
test("cancellation while the report is pending lets cleanup attribute and terminate the instance", async () => {
  const f = fixture();
  f.controller.abort();
  const report = Promise.withResolvers<number | undefined>();
  const instance = fixtureInstance(f);
  instance.report = () => report.promise;
  f.io.launch = uid => { f.calls.push(`launch:${uid}`); f.births.set(42, f.launched.born); return instance; };
  await expect(prepareDesktopSafari(f.state, 501, new AbortController().signal, { ...f.io, limits: { reportMs: 5, terminateMs: 20 } })).rejects.toThrow("timed out");
  report.resolve(42);
  instance.terminate = async () => { f.calls.push("terminate"); f.births.delete(42); return true; };
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
test("an instance that does not confirm termination keeps cleanup unproved and its helper waiting", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  f.control.terminates = false;
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
  // Released, not detached: the helper stays in the queue's group until the instance ends.
  expect(f.calls.slice(2)).toEqual(["terminate", "release"]);
});
test("a confirmed termination whose original process still exists stays unproved", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  const instance = f.state.launch.kind === "owned" ? f.state.launch.instance : undefined;
  if (!instance) throw new Error("Missing owned instance");
  instance.terminate = async () => { f.calls.push("terminate"); return true; };
  await expect(stopDesktopSafari(f.state, f.io)).rejects.toThrow("shutdown is unproved");
});
test("a reused PID after termination is neither signalled nor treated as the instance", async () => {
  const f = fixture();
  await prepareDesktopSafari(f.state, 501, f.controller.signal, f.io);
  const instance = f.state.launch.kind === "owned" ? f.state.launch.instance : undefined;
  if (!instance) throw new Error("Missing owned instance");
  instance.terminate = async () => { f.calls.push("terminate"); f.births.set(42, 99_000); return true; };
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls.slice(2)).toEqual(["terminate", "release"]);
});
test("a PID reused during the GUI allowance fails setup and terminates only through the instance", async () => {
  const f = fixture();
  f.io.wait = async () => { f.births.set(42, 16_000); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("bounded prelaunch");
  const instance = f.state.launch.kind === "owned" ? f.state.launch.instance : undefined;
  if (!instance) throw new Error("Missing owned instance");
  instance.terminate = async () => { f.calls.push("terminate"); return true; };
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "terminate", "release"]);
});
test("a second owner Safari during prelaunch blocks the driver without becoming owned", async () => {
  const f = fixture();
  f.io.wait = async () => { f.setApplications([{ pid: 42, started: 10_000 }, { pid: 77, started: 10_000 }]); };
  await expect(prepareDesktopSafari(f.state, 501, f.controller.signal, f.io)).rejects.toThrow("Owner Safari raced");
  await stopDesktopSafari(f.state, f.io);
  expect(f.calls).toEqual(["launch:501", "terminate", "release"]);
});
test("process discovery ignores simulator Safari and rejects malformed desktop identities", () => {
  const started = "Sun Nov  8 18:12:41 2026";
  expect(parseSafariApplications(` 42 ${started} /System/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari\n 7 ${started} /RuntimeRoot/Applications/MobileSafari.app/MobileSafari`)).toEqual([{ pid: 42, started: Date.parse(started) }]);
  expect(() => parseSafariApplications("invalid /Applications/Safari.app/Contents/MacOS/Safari")).toThrow();
  expect(() => parseSafariApplications(` 42 ${"invalid timestamp".padEnd(24)} /Applications/Safari.app/Contents/MacOS/Safari`)).toThrow();
});
test("the helper report names one positive PID or a launch failure", () => {
  expect(parseSafariReport('{"pid":26592}')).toBe(26592);
  expect(parseSafariReport('{"error":"LaunchServices did not launch Safari"}')).toBeUndefined();
  expect(parseSafariReport(undefined)).toBeUndefined();
  for (const line of ['{"pid":0}', '{"pid":-1}', '{"pid":1.5}', '{"pid":"42"}', "{}"]) expect(() => parseSafariReport(line)).toThrow("reported no Safari");
  expect(() => parseSafariReport("null")).toThrow("Invalid LaunchServices helper report");
});

// A stand-in helper process speaking the osascript helper's line protocol.
const fakeHelper = `
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
out({ pid: 4242 });
let buffered = "";
process.stdin.on("data", chunk => {
  buffered += chunk;
  if (buffered.includes("detach")) process.exit(3);
  if (buffered.includes("terminate")) { buffered = ""; out({ terminated: true }); }
});
process.stdin.on("end", () => process.exit(0));
`;
test("the retained helper reports, confirms termination and exits after release", async () => {
  const instance = helperInstance([process.execPath, "-e", fakeHelper]);
  expect(await instance.report()).toBe(4242);
  expect(await instance.terminate()).toBe(true);
  instance.release();
  expect(await instance.exited).toBe(0);
});
test("a detached helper ends without a termination request", async () => {
  const instance = helperInstance([process.execPath, "-e", fakeHelper]);
  expect(await instance.report()).toBe(4242);
  instance.detach();
  expect(await instance.exited).toBe(3);
});
test("a helper that exits without a report names no instance", async () => {
  const instance = helperInstance([process.execPath, "-e", "process.stdout.write(JSON.stringify({ error: 'none' }) + '\\n')"]);
  expect(await instance.report()).toBeUndefined();
  expect(await instance.terminate()).toBe(false);
  expect(await instance.exited).toBe(0);
});

test("desktop Safari launches through a LaunchServices helper and never signals a raw PID", async () => {
  // SafariDriver finds its Safari through LaunchServices. A directly executed binary gets a
  // separate record, so a stale record for an automatically terminated Safari wins instead.
  const source = await readFile(new URL("./native-safari.ts", import.meta.url), "utf8");
  expect(source).not.toContain("BUN_WASM_GOALS_SAFARI_OWNER");
  expect(source).not.toContain('"/Applications/Safari.app/Contents/MacOS/Safari"');
  expect(source).not.toContain("process.kill");
  expect(source).toContain("launchApplicationAtURLOptionsConfigurationError");
  expect(source).toContain("app.forceTerminate");
  expect(source).toContain('"/usr/bin/osascript", "-l", "JavaScript"');
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
