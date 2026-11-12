import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ownedCommand, withSignals } from "./lifetime";
import { requireNativeQueue } from "./mac-queue";
import { bounded } from "./execute";

export async function runIphoneServer(server: string, cleanupFile: string): Promise<void> {
  if (process.platform !== "darwin" || !isAbsolute(server) || !isAbsolute(cleanupFile)) throw new Error("Require Mac and absolute server/cleanup paths");
  await withSignals(async signal => {
    const checker = join(homedir(), ".agents/skills/machine-fleet/scripts/availability.py");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let stopped = true;
    try {
      await requireNativeQueue();
      await ownedCommand(["python3", checker, "check", "--owner-only"], signal);
      const driver = await ownedCommand(["/usr/bin/pgrep", "-x", "safaridriver"], signal, 5000, false, [0, 1]);
      if (driver.trim()) throw new Error("SafariDriver is active; visible iPhone run refused");
      signal.throwIfAborted();
      child = Bun.spawn([process.execPath, server], { stdout: "inherit", stderr: "inherit", env: process.env }); stopped = false;
      const code = await bounded(() => child!.exited, 86_400_000, signal);
      if (code !== 0) throw new Error(`iPhone asset server exited ${code}`);
    } catch (error) { if (!signal.aborted) throw error; }
    finally {
      if (child) { child.kill("SIGTERM"); await bounded(() => child!.exited, 10_000); stopped = true; }
      await writeFile(cleanupFile, JSON.stringify({ serverPid: child?.pid ?? null, serverExited: stopped, admissionOwner: "installed-mac-queue", safariDriverStarted: false, simulatorChanged: false, at: new Date().toISOString() }, null, 2));
    }
  });
}
if (import.meta.main) {
  const [server, cleanup] = process.argv.slice(2);
  if (!server || !cleanup) throw new Error("Usage: bun iphone-mac.js /absolute/iphone-server.js /absolute/cleanup.json");
  await runIphoneServer(server, cleanup);
}
