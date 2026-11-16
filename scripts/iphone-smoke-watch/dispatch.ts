import { join } from "node:path";
import type { Job } from "./model";

export const coordinator = "mcp:launch:d5c5eb90071799276e00d53b8b67c40ffef4a1f7b453c759a2d6463dc98733ec";
export const managing = "bd2baec7-7e23-49b0-8d20-31486beeb178";

function quoted(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function attemptDirectory(directory: string, job: Job): string {
  return join(directory, job.revision, `attempt-${job.state.attempt}`);
}

export function instructions(directory: string, checkout: string, job: Job): string {
  const attempt = job.state.attempt;
  const command = `cd ${quoted(checkout)} && source env.sh && bun scripts/iphone-smoke-watch.ts`;
  const identity = `--report-dir=${quoted(directory)} --revision=${job.revision} --attempt=${attempt}`;
  const output = attemptDirectory(directory, job);
  return [
    `Run scheduled iPhone smoke for exact successful push/main CI source ${job.revision}, run ${job.id}, attempt ${attempt}.`,
    `First atomically claim it: ${command} claim ${identity}. If claim fails, do no device work. A duplicate message must not start another UI session.`,
    `Prepare a clean checkout and build the guests/assets locally for ${job.revision}. Record the commit and run the low-level smoke command from that checkout, so its preflight reads the matching runtime sources. Use the installed watcher checkout for claim, complete and retry. CI run https://github.com/ShaulLavo/bun-wasm/actions/runs/${job.id} establishes successful main CI; do not wait for its build outputs. Never substitute or relabel the live sandbox.`,
    `Use fresh device_open for C4D2 and the existing Mac FIFO. Audit owner reservations and resources, install teardown before setup, then run bun scripts/iphone-smoke.ts with --root, --output, --source-file, --iphone-control-url, --iphone-agent-command, --device-udid and --mac-thread from the acquired session. Fixed cases are Vite + React Browser, Hono Browser, and Vite + React QuickJS on iPhone Safari through render and tap.`,
    `Keep controller reports under ${output}. The low-level runner emits kind manual-iphone-smoke with revision, source, status, failedPhase, reportPath, cases and ownership. After verified cleanup, finish via ${command} complete ${identity} --result-file=${quoted(join(output, "result.json"))}.`,
    `Any preparation/infrastructure failure must produce result.json with revision ${job.revision}, status red, failedPhase naming the failed setup phase and an absolute reportPath, then complete the job and notify managing. Never abandon a claimed job silently.`,
    `If this turn is interrupted, audit and stop its owned resources, retain a cleanup report, and explicitly retry with a fresh attempt. Never reuse a stale device session. See docs/development/iphone-smoke-automation.md.`,
  ].join("\n\n");
}
