import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { allocateSafariDriverPort, ownSafariDriver, stopSafariDriver } from "../../web/tests/engine-interruption-safari";
import { until } from "./playground";
import { withSignals, ownedCommand } from "./lifetime";
async function checkAvailability(signal: AbortSignal, ownerOnly = false): Promise<void> {
  await ownedCommand(["python3", join(homedir(), ".agents/skills/machine-fleet/scripts/availability.py"), "check"].concat(ownerOnly ? ["--owner-only"] : []), signal, 15_000);
}
type NativeResources = { lock: string; locked: boolean; stopped: boolean; port: number; driver?: ReturnType<typeof Bun.spawn>; owned?: ReturnType<typeof ownSafariDriver> };
export async function withNativeDriver<T>(operation: (endpoint: string, signal: AbortSignal) => Promise<T>, cleanupFile?: string): Promise<T> {
  if (process.platform !== "darwin") throw new Error("Native Safari driver must run on the discovered Mac");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Mac user identity is unavailable");
  return withSignals(signal => runNative(operation, uid, signal, cleanupFile));
}
async function runNative<T>(operation: (endpoint: string, signal: AbortSignal) => Promise<T>, uid: number, signal: AbortSignal, cleanupFile?: string): Promise<T> {
  const state: NativeResources = { lock: join(homedir(), "tmp/.agent-mac-lock"), locked: false, stopped: true, port: 0 };
  try {
    await checkAvailability(signal);
    signal.throwIfAborted(); await mkdir(state.lock); state.locked = true;
    await writeFile(join(state.lock, "owner"), `pid=${process.pid} task=bun-wasm-goals-matrix\n`);
    await checkAvailability(signal, true);
    const consoleState = await ownedCommand(["ioreg", "-n", "Root", "-d1"], signal);
    if (/CGSSessionScreenIsLocked[^\n]*Yes/.test(consoleState)) throw new Error("Desktop Safari requires an unlocked Mac console");
    state.port = await allocateSafariDriverPort();
    signal.throwIfAborted();
    const started = Date.now();
    state.driver = Bun.spawn(["/bin/launchctl", "asuser", String(uid), "/usr/bin/safaridriver", "--port", String(state.port)], { stdout: "ignore", stderr: "inherit" });
    state.stopped = false; state.owned = ownSafariDriver(state.driver, started, state.port);
    const endpoint = `http://127.0.0.1:${state.port}`;
    await until(() => driverReady(endpoint, signal), Boolean, 10_000);
    return await operation(endpoint, signal);
  } finally { await cleanupNative(state, cleanupFile); }
}
async function driverReady(endpoint: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return fetch(endpoint + "/status", { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false);
}
async function cleanupNative(state: NativeResources, cleanupFile?: string): Promise<void> {
  try {
    if (state.owned) await stopSafariDriver(state.owned, state.port);
    if (state.driver) await state.driver.exited;
    state.stopped = true;
  } finally {
    if (state.locked && state.stopped) { await rm(join(state.lock, "owner"), { force: true }); await rmdir(state.lock); state.locked = false; }
    if (cleanupFile) await receipt(cleanupFile, { driverPid: state.driver?.pid ?? null, port: state.port, driverExited: state.stopped, lockRemoved: !state.locked, simulatorChanged: false, at: new Date().toISOString() });
  }
}
async function receipt(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2)); }
