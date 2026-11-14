import { writeFile } from "node:fs/promises";
import { createGuard } from "./guard-server.ts";
import { command } from "./host.ts";
import type { GitHubApi, Session } from "./policy.ts";

export type GuardControl = "reject" | "timeout" | "cancel";

export async function controlGuard(options: { mode: GuardControl; directory: string; ssh: string[]; stopVm: () => Promise<void> }) {
  const session: Session = { jobId: 101, runId: 202, attempt: 3, runnerId: 303, headSha: "a".repeat(40) };
  const repo = { full_name: "ShaulLavo/bun-wasm" };
  const api: GitHubApi = async path => {
    await writeFile(`${options.directory}/approval-pending`, "");
    if (options.mode !== "reject") return new Promise<never>(() => undefined);
    if (path.includes("/actions/jobs/")) return { id: 101, run_id: 202, run_attempt: 3, head_sha: session.headSha, status: "in_progress", runner_id: 999, labels: ["self-hosted", "linux", "x64", "pc", "bun-wasm"] };
    if (path.includes("/actions/runs/")) return { id: 202, run_attempt: 3, head_sha: session.headSha, status: "in_progress", conclusion: null, repository: repo, head_repository: repo, event: "pull_request", pull_requests: [{ number: 404 }] };
    return { state: "open", head: { repo, sha: session.headSha }, base: { repo } };
  };
  const guard = await createGuard({ session, api, stopVm: options.stopVm, timeoutMs: options.mode === "timeout" ? 3000 : 120_000 });
  command(["ssh"].concat(options.ssh, ["sudo /usr/bin/install -m 0444 /dev/stdin /etc/bun-wasm-ci/session.json"]), { input: JSON.stringify({ url: guard.url, token: guard.token }) });
  return guard;
}

export const continuationControl = ["/bin/bash", "-c", "export GITHUB_RUN_ID=202 GITHUB_RUN_ATTEMPT=3; /opt/bun-wasm-ci/guard-hook.sh || true; echo ALWAYS_CONTINUED; exit 88"];
