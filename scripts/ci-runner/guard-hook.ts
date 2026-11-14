import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function stopGuest(): never {
  spawnSync("/usr/bin/sudo", ["/usr/bin/systemctl", "poweroff", "--force", "--force"], { stdio: "ignore", timeout: 5000 });
  spawnSync("/usr/bin/sudo", ["/usr/bin/kill", "-s", "KILL", "-1"], { stdio: "ignore", timeout: 5000 });
  const blocked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(blocked, 0, 0, 1000);
}

async function guard(): Promise<void> {
  const config: unknown = JSON.parse(readFileSync("/etc/bun-wasm-ci/session.json", "utf8"));
  if (typeof config !== "object" || config === null || !("url" in config) || !("token" in config) || typeof config.url !== "string" || typeof config.token !== "string") return stopGuest();
  if (!/^http:\/\/10\.0\.2\.2:\d+\/approve$/.test(config.url) || !/^[a-f0-9]{64}$/.test(config.token)) return stopGuest();
  const result = await fetch(config.url, {
    method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }), signal: AbortSignal.timeout(15_000),
  });
  const decision: unknown = await result.json();
  if (!result.ok || typeof decision !== "object" || decision === null || !("approved" in decision) || decision.approved !== true) return stopGuest();
  const mounted = spawnSync("/usr/bin/sudo", ["/usr/bin/mount", "/dev/disk/by-id/virtio-bunwasmcache", "/work/ci-runner/bun-wasm/cache"], { stdio: "ignore", timeout: 15_000 });
  if (mounted.status !== 0) return stopGuest();
  const ownership = spawnSync("/usr/bin/sudo", ["/usr/bin/chown", "runner:runner", "/work/ci-runner/bun-wasm/cache"], { stdio: "ignore", timeout: 5000 });
  if (ownership.status !== 0) return stopGuest();
}

guard().catch(() => stopGuest());
