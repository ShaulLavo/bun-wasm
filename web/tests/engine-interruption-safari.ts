import { createServer } from "node:net";

export interface SafariDriverIdentity { pid: number; exitCode: number | null; signalCode: string | number | null; }

// Reserve a private random port until the child is about to bind. Port allocation
// alone cannot close the release/bind race, so every WebDriver request also checks
// the listener's real process identity and the owned child's health.
export async function allocateSafariDriverPort(requested = 0): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: requested, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Safari driver port allocation failed");
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function assertAlive(driver: SafariDriverIdentity): void {
  if (driver.exitCode !== null || driver.signalCode !== null) throw new Error(`owned Safari driver ${driver.pid} exited (${driver.exitCode ?? driver.signalCode})`);
}

async function listenerPids(port: number): Promise<number[]> {
  const command = Bun.spawn(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "pipe", timeout: 2_000, killSignal: "SIGKILL" });
  const stdout = new Response(command.stdout).text(), stderr = new Response(command.stderr).text();
  const status = await command.exited;
  const output = (await stdout).trim(), errors = (await stderr).trim();
  if (status !== 0 && !(status === 1 && !output && !errors)) throw new Error(`Safari listener ownership inspection failed (${status}): ${errors}`);
  if (!output) return [];
  const pids = output.split(/\s+/).map(Number);
  if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error("invalid Safari listener process identity");
  return Array.from(new Set(pids));
}

export async function assertSafariDriverOwnership(driver: SafariDriverIdentity, port: number,
  inspect: (port: number) => Promise<number[]> = listenerPids): Promise<void> {
  assertAlive(driver);
  const pids = await inspect(port);
  assertAlive(driver);
  if (pids.length !== 1 || pids[0] !== driver.pid) throw new Error(`Safari driver port ${port} not owned by task-created driver ${driver.pid}: ${pids.join(",") || "no listener"}`);
}
