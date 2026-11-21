import { spawnSync } from "node:child_process";

// The probe the smoke workers use: Tailscale must list the Mac online, then Mesh SSH must answer.
const macTailscaleName = "shauls-macbook-air";
const macMeshName = "mac";
export type Command = (file: string, args: readonly string[], timeoutMs: number) => { status: number | null; stdout: string };

const run: Command = (file, args, timeoutMs) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

function online(status: string): boolean {
  const line = status.split("\n").find(row => row.trim().split(/\s+/)[1] === macTailscaleName);
  return line !== undefined && !/\boffline\b/.test(line);
}

/** Bounded to 10 s for Tailscale and 20 s for SSH; Mesh is skipped while Tailscale lists the Mac offline. */
export function macReachable(command: Command = run): boolean {
  const status = command("tailscale", ["status"], 10_000);
  if (status.status !== 0 || !online(status.stdout)) return false;
  return command("mesh", ["ssh", macMeshName, "--", "true"], 20_000).status === 0;
}
