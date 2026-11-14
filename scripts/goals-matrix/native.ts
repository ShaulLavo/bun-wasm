import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { allocateSafariDriverPort, ownSafariDriver, stopSafariDriver } from "../../web/tests/engine-interruption-safari";
import { until } from "./playground";
import { withSignals, ownedCommand } from "./lifetime";
import { requireNativeQueue } from "./mac-queue";
import { prepareDesktopSafari, stopDesktopSafari, type DesktopSafari } from "./native-safari";
import type { ExitOwner } from "./safari-exit-observer";
async function checkAvailability(signal: AbortSignal): Promise<void> {
  await ownedCommand(["python3", join(homedir(), ".agents/skills/machine-fleet/scripts/availability.py"), "check", "--owner-only"], signal, 15_000);
}
type NativeResources = { safari: DesktopSafari; safariStopped: boolean; stopped: boolean; port: number; driver?: ReturnType<typeof Bun.spawn>; owned?: ReturnType<typeof ownSafariDriver> };
type NativeOptions = { desktopSafari: boolean; cleanupFile?: string; exitOwner?: Pick<ExitOwner, "attempt"> };
export interface NativeHost {
  platform: string;
  uid(): number | undefined;
  signals: typeof withSignals;
  queue(): Promise<void>;
  available(signal: AbortSignal): Promise<void>;
  console(signal: AbortSignal): Promise<string>;
  prepare: typeof prepareDesktopSafari;
  port: typeof allocateSafariDriverPort;
  spawn(uid: number, port: number): ReturnType<typeof Bun.spawn>;
  own: typeof ownSafariDriver;
  ready: typeof driverReady;
  stopDriver: typeof stopSafariDriver;
  stopApp: typeof stopDesktopSafari;
}
const nativeHost: NativeHost = {
  platform: process.platform, uid: () => process.getuid?.(), signals: withSignals, queue: requireNativeQueue,
  available: checkAvailability, console: signal => ownedCommand(["ioreg", "-n", "Root", "-d1"], signal),
  prepare: prepareDesktopSafari, port: allocateSafariDriverPort, own: ownSafariDriver, ready: driverReady,
  spawn: (uid, port) => Bun.spawn(["/bin/launchctl", "asuser", String(uid), "/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "inherit" }),
  stopDriver: stopSafariDriver, stopApp: stopDesktopSafari,
};
export async function withNativeDriver<T>(operation: (endpoint: string, signal: AbortSignal) => Promise<T>, config: NativeOptions, io: NativeHost = nativeHost): Promise<T> {
  if (io.platform !== "darwin") throw new Error("Native Safari driver must run on the discovered Mac");
  const uid = io.uid();
  if (uid === undefined) throw new Error("Mac user identity is unavailable");
  return io.signals(signal => runNative(operation, uid, signal, config, io));
}
async function runNative<T>(operation: (endpoint: string, signal: AbortSignal) => Promise<T>, uid: number, signal: AbortSignal, config: NativeOptions, io: NativeHost): Promise<T> {
  const state: NativeResources = { safari: { launch: { kind: "none" } }, safariStopped: true, stopped: true, port: 0 };
  const operationAndSetup = async () => {
    await io.queue();
    await io.available(signal);
    const consoleState = await io.console(signal);
    if (/CGSSessionScreenIsLocked[^\n]*Yes/.test(consoleState)) throw new Error("Desktop Safari requires an unlocked Mac console");
    if (config.desktopSafari) {
      state.safariStopped = false;
      await io.prepare(state.safari, uid, signal);
    }
    state.port = await io.port();
    signal.throwIfAborted();
    const started = Date.now();
    state.driver = io.spawn(uid, state.port);
    state.stopped = false; state.owned = io.own(state.driver, started, state.port);
    const endpoint = `http://127.0.0.1:${state.port}`;
    await until(() => io.ready(endpoint, signal), Boolean, 10_000);
    return await operation(endpoint, signal);
  };
  if (config.exitOwner) return config.exitOwner.attempt(operationAndSetup, [
    { phase: "driver-teardown", run: () => stopNativeDriver(state, io) },
    { phase: "app-teardown", run: async () => { await io.stopApp(state.safari); state.safariStopped = true; } },
    { phase: "final-drain", run: () => nativeReceipt(state, config.cleanupFile) },
  ]);
  try { return await operationAndSetup(); }
  finally { await cleanupNative(state, io, config.cleanupFile); }
}
async function driverReady(endpoint: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return fetch(endpoint + "/status", { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false);
}
async function stopNativeDriver(state: NativeResources, io: NativeHost): Promise<void> {
  if (state.owned) await io.stopDriver(state.owned, state.port);
  if (state.driver) await state.driver.exited;
  state.stopped = true;
}
async function cleanupNative(state: NativeResources, io: NativeHost, cleanupFile?: string): Promise<void> {
  try {
    await stopNativeDriver(state, io);
    await io.stopApp(state.safari); state.safariStopped = true;
  } finally {
    await nativeReceipt(state, cleanupFile);
  }
}
async function nativeReceipt(state: NativeResources, cleanupFile?: string): Promise<void> {
  if (cleanupFile) await receipt(cleanupFile, { safariPids: state.safari.launch.kind === "owned" ? [state.safari.launch.application.pid] : [], safariLaunch: state.safari.launch.kind, safariExited: state.safariStopped, driverPid: state.driver?.pid ?? null, port: state.port, driverExited: state.stopped, admissionOwner: "installed-mac-queue", simulatorChanged: false, at: new Date().toISOString() });
}
async function receipt(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2)); }
