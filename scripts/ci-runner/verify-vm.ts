import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command, root } from "./host.ts";

const report = "/work/reports/goals/ci-speed-20261114/vm-controls.json";

async function probe(mode: "success" | "reject" | "timeout" | "cancel") {
  const before = new Set(await readdir(`${root}/results`));
  const args = mode === "success" ? ["control", "native", "--", "/bin/bash", "-euc", "setsid sleep 600 >/dev/null 2>&1 & echo GUEST_DETACHED_READY"] : ["guard-control", mode];
  const child = spawn(`${root}/bin/bun`, [new URL("./vm.ts", import.meta.url).pathname].concat(args), { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64_000); });
  child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64_000); });
  let finished = false;
  const exited = new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", code => { finished = true; resolveExit(code); }); });
  const deadline = performance.now() + 1_800_000;
  let cancelled = false;
  try {
    while (!finished && performance.now() < deadline) {
      const jobs = await readdir(`${root}/jobs`);
      if (mode === "cancel" && !cancelled && jobs.some(id => existsSync(`${root}/jobs/${id}/approval-pending`))) {
        command(["systemctl", "--user", "stop", "bun-wasm-ci-vm.service"]);
        cancelled = true;
      }
      await delay(1000);
    }
    if (!finished) throw new Error("VM proof admission/runtime deadline exceeded");
    const code = await exited;
    if ((mode === "success" && code !== 0) || (mode !== "success" && code === 0) || output.includes("ALWAYS_CONTINUED")) throw new Error(`VM ${mode} control failed`);
    const resultName = (await readdir(`${root}/results`)).find(file => !before.has(file));
    if (!resultName) throw new Error("Missing VM cleanup evidence");
    const result: unknown = JSON.parse(await readFile(`${root}/results/${resultName}`, "utf8"));
    if (typeof result !== "object" || result === null || !("cleanup" in result) || result.cleanup !== "drained" || !("control" in result)) throw new Error("Missing owned-cgroup drain proof");
    if (mode !== "success" && (!("approvalPending" in result) || result.approvalPending !== true)) throw new Error("Control did not reach host API binding");
    if (mode === "reject" || mode === "timeout") verifyGuardEvidence(result, mode);
    const control = result.control;
    if (typeof control !== "object" || control === null || !("pid" in control) || typeof control.pid !== "number" || !("session" in control) || control.session !== String(control.pid)) throw new Error("Detached session positive control was not created");
    if (existsSync(`/proc/${control.pid}`)) throw new Error("Owned detached control survived VM teardown");
    if ((await readdir(`${root}/jobs`)).length !== 0) throw new Error("VM key/overlay backing remains");
    return { mode, code, cancelled, alwaysContinued: false, result, output };
  } finally {
    if (!finished) command(["systemctl", "--user", "stop", "bun-wasm-ci-vm.service"]);
    await exited;
  }
}

function verifyGuardEvidence(result: object, mode: "reject" | "timeout"): void {
  if (!("guard" in result) || typeof result.guard !== "object" || result.guard === null) throw new Error("Missing host guard evidence");
  const guard = result.guard;
  if (!("authenticated" in guard) || guard.authenticated !== true || !("apiChecked" in guard) || guard.apiChecked !== true || !("approved" in guard) || guard.approved !== false || !("decision" in guard) || guard.decision !== (mode === "reject" ? "policy" : "timeout")) throw new Error("Host guard did not enforce the expected denial");
}

async function main(): Promise<void> {
  const results = [];
  for (const mode of ["success", "reject", "timeout", "cancel"] as const) {
    process.stdout.write(`Checking VM ${mode} control\n`);
    results.push(await probe(mode));
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify({ results }, null, 2));
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "VM proof failed"}\n`); process.exitCode = 1; });
