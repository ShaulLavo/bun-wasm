import { readFile, writeFile } from "node:fs/promises";
import { createGuard } from "./guard-server.ts";
import { github, namedRunner, registrationToken } from "./github.ts";
import { command, root } from "./host.ts";
import { eligibleQueuedJob, type Admission } from "./policy.ts";

export async function readAdmission(path: string): Promise<Admission> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || !("jobId" in value) || !("runId" in value) || !("attempt" in value) || !("headSha" in value)) throw new Error("Invalid runner admission");
  if (typeof value.jobId !== "number" || typeof value.runId !== "number" || typeof value.attempt !== "number" || typeof value.headSha !== "string") throw new Error("Invalid runner admission");
  return { jobId: value.jobId, runId: value.runId, attempt: value.attempt, headSha: value.headSha };
}

export async function revalidateAdmission(admission: Admission): Promise<void> {
  const actual = await eligibleQueuedJob(github, admission.jobId);
  if (actual.runId !== admission.runId || actual.attempt !== admission.attempt || actual.headSha !== admission.headSha) throw new Error("Queued admission changed");
}

export async function setupSession(options: { id: string; ssh: string[]; admission: Admission; stopVm: () => Promise<void> }) {
  const directory = `${root}/jobs/${options.id}`;
  const name = `pc-bun-wasm-${options.id}`;
  await revalidateAdmission(options.admission);
  await writeFile(`${directory}/registration.json`, JSON.stringify({ name }), { mode: 0o600 });
  const token = await registrationToken();
  command(["ssh"].concat(options.ssh, ["/opt/node/bin/node /opt/bun-wasm-ci/runner-guest.ts configure"]), { input: JSON.stringify({ token, name }), timeout: 150_000 });
  const runnerId = await namedRunner(name);
  if (runnerId === undefined) throw new Error("Registered runner missing from API");
  await writeFile(`${directory}/registration.json`, JSON.stringify({ name, runnerId }), { mode: 0o600 });
  const guard = await createGuard({ session: { runnerId }, api: github, stopVm: options.stopVm });
  try {
    command(["ssh"].concat(options.ssh, ["sudo /usr/bin/install -m 0444 /dev/stdin /etc/bun-wasm-ci/session.json"]), { input: JSON.stringify({ url: guard.url, token: guard.token }) });
  } catch (error) {
    await guard.close();
    throw error;
  }
  return guard;
}
