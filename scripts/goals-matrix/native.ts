import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { allocateSafariDriverPort, ownSafariDriver, stopSafariDriver } from "../../web/tests/engine-interruption-safari";
import { until } from "./playground";
async function checkAvailability(ownerOnly = false): Promise<void> {
  const command = Bun.spawn(["python3", join(homedir(), ".agents/skills/machine-fleet/scripts/availability.py"), "check"].concat(ownerOnly ? ["--owner-only"] : []), { stdout: "inherit", stderr: "inherit" });
  if (await command.exited !== 0) throw new Error("Mac is reserved or availability discovery failed");
}
export async function withNativeDriver<T>(operation: (endpoint: string) => Promise<T>, cleanupFile?: string): Promise<T> {
  if (process.platform !== "darwin") throw new Error("Native Safari driver must run on the discovered Mac");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Mac user identity is unavailable");
  await checkAvailability();
  const lock = join(homedir(), "tmp/.agent-mac-lock");
  await mkdir(lock);
  let driver: ReturnType<typeof Bun.spawn> | undefined;
  let owned: ReturnType<typeof ownSafariDriver> | undefined;
  let port = 0;
  try {
    await writeFile(join(lock, "owner"), `pid=${process.pid} task=bun-wasm-goals-matrix\n`);
    await checkAvailability(true);
    const consoleState = Bun.spawn(["ioreg", "-n", "Root", "-d1"], { stdout: "pipe" });
    const state = await new Response(consoleState.stdout).text();
    if (await consoleState.exited !== 0 || /CGSSessionScreenIsLocked[^\n]*Yes/.test(state)) throw new Error("Desktop Safari requires an unlocked Mac console");
    port = await allocateSafariDriverPort();
    const started = Date.now();
    driver = Bun.spawn(["/bin/launchctl", "asuser", String(uid), "/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "inherit" });
    owned = ownSafariDriver(driver, started, port);
    const endpoint = `http://127.0.0.1:${port}`;
    await until(async () => fetch(endpoint + "/status", { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false), Boolean, 10_000);
    return await operation(endpoint);
  } finally {
    try { if (owned) await stopSafariDriver(owned, port); if (driver) await driver.exited; }
    finally {
      await rm(join(lock, "owner"), { force: true }); await rmdir(lock);
      if (cleanupFile) await writeFile(cleanupFile, JSON.stringify({ driverPid: driver?.pid ?? null, port, driverExited: driver?.exitCode !== null, lockRemoved: true, simulatorChanged: false, at: new Date().toISOString() }, null, 2));
    }
  }
}
