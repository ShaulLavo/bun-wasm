import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cloudConfig, guestCommand } from "./guest.ts";
import { command, root, toolEnvironment, verifyStorage } from "./host.ts";
import { removeRunner } from "./github.ts";
import type { Admission } from "./policy.ts";
import { readAdmission, revalidateAdmission, setupSession } from "./session.ts";
import { continuationControl, controlGuard, type GuardControl } from "./controls.ts";
import { prepareVmSettings } from "./resources.ts";
import { baseImage, publishPreparedImage, validatePreparationIdle, validatePreparationTarget } from "./image.ts";

type Profile = "native" | "browser";
type Job = { id: string; profile: Profile; prepare: boolean; control: boolean; argv: string[] };
type Ownership = { slice: string; guest: string; cgroup: string };
const outerUnit = "bun-wasm-ci-vm.service";
const base = `${root}/images/${baseImage}`;
const source = new URL(import.meta.url).pathname;
const runtime = process.execPath;

function jobPath(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid VM job identity");
  return `${root}/jobs/${id}`;
}

async function readJob(id: string): Promise<Job> {
  const value: unknown = JSON.parse(await readFile(`${jobPath(id)}/request.json`, "utf8"));
  if (typeof value !== "object" || value === null || !("id" in value) || !("profile" in value) || !("prepare" in value) || !("control" in value) || !("argv" in value)) throw new Error("Invalid VM request");
  if (value.id !== id || (value.profile !== "native" && value.profile !== "browser") || typeof value.prepare !== "boolean" || typeof value.control !== "boolean" || !Array.isArray(value.argv) || !value.argv.every(arg => typeof arg === "string")) throw new Error("Invalid VM request");
  return { id, profile: value.profile, prepare: value.prepare, control: value.control, argv: value.argv };
}

async function readOwnership(id: string): Promise<Ownership | undefined> {
  const path = `${jobPath(id)}/ownership.json`;
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || !("slice" in value) || !("guest" in value) || !("cgroup" in value)) throw new Error("Invalid VM ownership");
  if (typeof value.slice !== "string" || !/^heavy-[a-zA-Z0-9_]+\.slice$/.test(value.slice) || value.guest !== `bun-wasm-ci-guest-${id}.service` || typeof value.cgroup !== "string") throw new Error("Invalid owned VM units");
  if (!value.cgroup.startsWith("/user.slice/user-1000.slice/user@1000.service/")) throw new Error("Unexpected VM cgroup");
  return { slice: value.slice, guest: value.guest, cgroup: value.cgroup };
}

function stopUnit(unit: string): void {
  const state = unitProperty(unit, "LoadState");
  if (state === "not-found") return;
  command(["systemctl", "--user", "stop", unit], { timeout: 30_000 });
}

function unitProperty(unit: string, property: string): string {
  const result = spawnSync("systemctl", ["--user", "show", unit, "-p", property, "--value"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 && result.status !== 1) throw new Error("Cannot inspect owned unit");
  return result.stdout.trim();
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit, reject) => { child.once("error", () => reject(new Error("Cannot start VM helper"))); child.once("exit", resolveExit); });
}

async function drained(cgroup: string): Promise<boolean> {
  const path = `/sys/fs/cgroup${cgroup}/cgroup.events`;
  if (!existsSync(path)) return true;
  return /^populated 0$/m.test(await readFile(path, "utf8"));
}

async function cleanup(id: string): Promise<void> {
  if (!existsSync(jobPath(id))) return;
  const owner = await readOwnership(id);
  if (!owner) return;
  stopUnit(owner.guest);
  const slicePath = unitProperty(owner.slice, "ControlGroup");
  stopUnit(owner.slice);
  if (!await drained(owner.cgroup) || (slicePath && !await drained(slicePath))) throw new Error("Owned VM cgroup remains populated");
  await writeFile(`${jobPath(id)}/cleanup.json`, JSON.stringify({ guest: owner.guest, slice: owner.slice, cgroup: owner.cgroup, populated: false, checkedAt: new Date().toISOString() }));
}

async function finalize(id: string): Promise<void> {
  if (!existsSync(jobPath(id))) return;
  await cleanup(id);
  const job = await readJob(id);
  const succeeded = existsSync(`${jobPath(id)}/success`);
  let publicationError: unknown;
  try {
    if (job.prepare && succeeded) await publishPreparedImage(`${jobPath(id)}/root.qcow2`, base);
  } catch (error) {
    publicationError = error;
  }
  await rm(`${jobPath(id)}/key`, { force: true });
  await rm(`${jobPath(id)}/root.qcow2`, { force: true });
  const registration = `${jobPath(id)}/registration.json`;
  if (existsSync(registration)) await removeRunner(`pc-bun-wasm-${id}`);
  await mkdir(`${root}/results`, { recursive: true });
  const owner = await readOwnership(id);
  const errors = await readFile(`${jobPath(id)}/qemu-errors.log`, "utf8").catch(() => "");
  const bootTail = succeeded ? "" : (await readFile(`${jobPath(id)}/serial.log`, "utf8").catch(() => "")).slice(-4096);
  const control = await readFile(`${jobPath(id)}/control.json`, "utf8").catch(() => "null");
  const guard = await readFile(`${jobPath(id)}/guard-evidence.json`, "utf8").catch(() => "null");
  await writeFile(`${root}/results/${id}.json`, JSON.stringify({ id, profile: job.profile, prepare: job.prepare, succeeded: succeeded && !publicationError, publicationError: publicationError instanceof Error ? publicationError.message : null, ownership: owner ?? null, cleanup: owner ? "drained" : "not-started", errors, bootTail, control: JSON.parse(control), guard: JSON.parse(guard), approvalPending: existsSync(`${jobPath(id)}/approval-pending`), checkedAt: new Date().toISOString() }));
  await rm(jobPath(id), { recursive: true, force: true });
  if (publicationError) throw publicationError;
}

async function choosePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePort); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing VM SSH port");
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}

async function seed(job: Job): Promise<void> {
  const directory = jobPath(job.id);
  await copyFile(`${root}/tools/usr/share/edk2/x64/OVMF_VARS.4m.fd`, `${directory}/vars.fd`);
  const key = `${directory}/key`;
  command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
  await writeFile(`${directory}/user-data`, cloudConfig(await readFile(`${key}.pub`, "utf8"), job.prepare, !existsSync(`${directory}/admission.json`) && !job.argv[0]?.startsWith("__guard-")));
  await writeFile(`${directory}/meta-data`, JSON.stringify({ "instance-id": job.id, "local-hostname": "bun-wasm-ci" }));
  const fd = openSync(`${directory}/seed.img`, "w");
  closeSync(fd);
  command(["truncate", "-s", "8M", `${directory}/seed.img`]);
  command([`${root}/tools/usr/bin/mkfs.vfat`, "-n", "CIDATA", `${directory}/seed.img`], { env: toolEnvironment() });
  command([`${root}/tools/usr/bin/mcopy`, "-i", `${directory}/seed.img`, `${directory}/user-data`, "::user-data"], { env: toolEnvironment() });
  command([`${root}/tools/usr/bin/mcopy`, "-i", `${directory}/seed.img`, `${directory}/meta-data`, "::meta-data"], { env: toolEnvironment() });
}

function sshArgs(job: Job, port: number): string[] {
  return ["-i", `${jobPath(job.id)}/key`, "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${jobPath(job.id)}/known_hosts`, "-o", "LogLevel=ERROR", "runner@127.0.0.1"];
}

async function waitReady(job: Job, port: number, alive: () => boolean): Promise<void> {
  const deadline = performance.now() + (job.prepare ? 1_800_000 : 180_000);
  while (performance.now() < deadline) {
    if (!alive()) throw new Error("QEMU exited before guest readiness");
    const result = spawn("ssh", sshArgs(job, port).concat(["test -f /var/lib/bun-wasm-ci-ready"]), { stdio: "ignore" });
    if (await exitCode(result) === 0) return;
    await delay(1_000);
  }
  throw new Error("Guest readiness deadline exceeded");
}

export function qemuArgs(job: Pick<Job, "id" | "profile" | "prepare">, port: number): string[] {
  const directory = jobPath(job.id);
  const memory = job.profile === "native" ? 6144 : 8192;
  const cache = job.prepare ? [] : ["-drive", `file=${root}/cache/cache.raw,format=raw,if=none,id=cache`, "-device", "virtio-blk-pci,drive=cache,serial=bunwasmcache"];
  return ["-enable-kvm", "-cpu", "host", "-smp", "4", "-m", String(memory), "-object", `memory-backend-ram,id=mem,size=${memory}M,prealloc=on`, "-machine", "q35,memory-backend=mem,dump-guest-core=off,mem-merge=off", "-display", "none", "-monitor", "none", "-qmp", `unix:${directory}/qmp.sock,server=on,wait=off`, "-boot", "c", "-serial", `file:${directory}/serial.log`, "-no-reboot", "-L", `${root}/tools/usr/share/qemu`, "-drive", `if=pflash,format=raw,readonly=on,file=${root}/tools/usr/share/edk2/x64/OVMF_CODE.4m.fd`, "-drive", `if=pflash,format=raw,file=${directory}/vars.fd`, "-drive", `file=${directory}/root.qcow2,format=qcow2,if=virtio`, ].concat(cache, ["-drive", `file=${directory}/seed.img,format=raw,if=virtio,readonly=on`, "-netdev", `user,id=net,hostfwd=tcp:127.0.0.1:${port}-:22`, "-device", "virtio-net-pci,netdev=net"]);
}

async function guest(job: Job): Promise<void> {
  const directory = jobPath(job.id);
  if (existsSync("/home/shaul/.local/state/machine-fleet/owner-busy")) throw new Error("PC is reserved by its owner");
  const admissionPath = `${directory}/admission.json`;
  const admission = existsSync(admissionPath) ? await readAdmission(admissionPath) : undefined;
  if (admission) await revalidateAdmission(admission);
  if (job.control) {
    const detached = spawn("/usr/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
    detached.unref();
    await writeFile(`${directory}/control.json`, JSON.stringify({ pid: detached.pid, cgroup: await readFile(`/proc/${detached.pid}/cgroup`, "utf8"), session: command(["ps", "-o", "sid=", "-p", String(detached.pid)]).trim() }));
  }
  await seed(job);
  command([`${root}/tools/usr/bin/qemu-img`, "create", "-f", "qcow2", "-F", "qcow2", "-b", job.prepare ? `${root}/images/ubuntu-noble.qcow2` : base, `${directory}/root.qcow2`], { env: toolEnvironment() });
  command([`${root}/tools/usr/bin/qemu-img`, "resize", `${directory}/root.qcow2`, "80G"], { env: toolEnvironment() });
  if (!job.prepare && !existsSync(`${root}/cache/cache.raw`)) command([`${root}/tools/usr/bin/qemu-img`, "create", "-f", "raw", `${root}/cache/cache.raw`, "128G"], { env: toolEnvironment() });
  const port = await choosePort();
  const qemu = spawn(`${root}/tools/usr/bin/qemu-system-x86_64`, qemuArgs(job, port), { env: { ...toolEnvironment(), QEMU_MODULE_DIR: `${root}/tools/usr/lib/qemu` }, stdio: ["ignore", "ignore", "pipe"] });
  const errors: Buffer[] = [];
  qemu.stderr.on("data", (chunk: Buffer) => { if (errors.length < 20) errors.push(chunk); });
  let alive = true;
  qemu.on("exit", () => { alive = false; });
  const exited = new Promise<void>(resolveExit => qemu.once("exit", () => resolveExit()));
  const ownerWatch = setInterval(() => { if (existsSync("/home/shaul/.local/state/machine-fleet/owner-busy")) qemu.kill("SIGKILL"); }, 5000);
  let guard: Awaited<ReturnType<typeof setupSession>> | undefined;
  try {
    await waitReady(job, port, () => alive);
    if (admission) guard = await setupSession({ id: job.id, admission, ssh: sshArgs(job, port), stopVm: async () => { qemu.kill("SIGKILL"); await exited; } });
    const control = job.argv[0];
    let argv = job.argv;
    if (control === "__guard-reject__" || control === "__guard-timeout__" || control === "__guard-cancel__") {
      const mode: GuardControl = control === "__guard-reject__" ? "reject" : control === "__guard-timeout__" ? "timeout" : "cancel";
      guard = await controlGuard({ mode, directory, ssh: sshArgs(job, port), stopVm: async () => { qemu.kill("SIGKILL"); await exited; } });
      argv = continuationControl;
    }
    const args = sshArgs(job, port).concat([guestCommand(argv)]);
    const payload = spawn("ssh", args, { stdio: "inherit" });
    const code = await exitCode(payload);
    if (code !== 0) throw new Error(`Guest command exited ${code}`);
    const scrub = job.prepare ? "sudo cloud-init clean --logs --machine-id; sudo rm -f /home/runner/.ssh/authorized_keys /etc/ssh/ssh_host_* /var/lib/bun-wasm-ci-ready; " : "";
    command(["ssh"].concat(sshArgs(job, port), [`${scrub}sudo systemctl poweroff --no-block`]));
    await Promise.race([exited, delay(30_000, undefined, { ref: false }).then(() => { throw new Error("Guest shutdown deadline exceeded"); })]);
  } finally {
    clearInterval(ownerWatch);
    qemu.kill("SIGKILL");
    await exited;
    if (guard) await writeFile(`${directory}/guard-evidence.json`, JSON.stringify(guard.evidence));
    await guard?.close();
    await writeFile(`${directory}/qemu-errors.log`, Buffer.concat(errors));
  }
}

async function admitted(job: Job): Promise<void> {
  const slice = process.env.HEAVY_JOB_SLICE;
  if (!slice || !/^heavy-[a-zA-Z0-9_]+\.slice$/.test(slice)) throw new Error("VM requires installed heavy-runner admission");
  const unit = `bun-wasm-ci-guest-${job.id}.service`;
  const cgroup = command(["systemctl", "--user", "show", slice, "-p", "ControlGroup", "--value"]).trim();
  await writeFile(`${jobPath(job.id)}/ownership.json`, JSON.stringify({ slice, guest: unit, cgroup }));
  const args = ["--user", "--wait", "--pipe", "--collect", "--quiet", `--unit=${unit}`, `--slice=${slice}`, "--service-type=exec", "-p", "KillMode=control-group", "-p", "SendSIGKILL=yes", "-p", "TimeoutStopSec=10s", "-p", "RuntimeMaxSec=2h", runtime, source, "guest", job.id];
  const child = spawn("systemd-run", args, { stdio: "inherit" });
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`Guest service exited ${code}`);
  await writeFile(`${jobPath(job.id)}/success`, "");
}

async function launch(job: Job, admission?: Admission): Promise<void> {
  await verifyStorage();
  if (unitProperty(outerUnit, "ActiveState") === "active") throw new Error("One CI VM is already queued or running");
  for (const pending of await readdir(`${root}/jobs`)) await finalize(pending);
  await mkdir(jobPath(job.id), { recursive: true, mode: 0o700 });
  await writeFile(`${jobPath(job.id)}/request.json`, JSON.stringify(job), { mode: 0o600 });
  if (admission) await writeFile(`${jobPath(job.id)}/admission.json`, JSON.stringify(admission), { mode: 0o600 });
  const settingsHome = await prepareVmSettings();
  const args = ["--user", "--wait", "--pipe", "--collect", "--quiet", `--unit=${outerUnit}`, "--service-type=exec", "-p", "PartOf=bun-wasm-ci-controller.service", "-p", "KillMode=control-group", "-p", "TimeoutStopSec=20s", "-p", "RuntimeMaxSec=3h", "-p", `ExecStopPost=${runtime} ${source} finalize ${job.id}`, runtime, "/work/heavy-runner/current/run.js", "--host", "local", "--settings-home", settingsHome, "--class", job.profile === "native" ? "suite" : "browser", `pc-ci-${job.prepare ? "prepare" : job.profile}-${job.id}`, "--", runtime, source, "admitted", job.id];
  const child = spawn("systemd-run", args, { stdio: "inherit" });
  const cancel = () => { stopUnit(outerUnit); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let code: number | null;
  try {
    code = await exitCode(child);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await finalize(job.id);
  }
  if (code !== 0) throw new Error(`VM lifecycle exited ${code}`);
}

export async function launchRunner(profile: Profile, admission: Admission): Promise<void> {
  if (!existsSync(base)) throw new Error("Prepare the offline base image first");
  await launch({ id: randomUUID(), profile, prepare: false, control: false, argv: ["/opt/node/bin/node", "/opt/bun-wasm-ci/runner-guest.ts", "listen"] }, admission);
}

async function main(): Promise<void> {
  const operation = process.argv[2];
  const id = process.argv[3];
  if (operation === "cleanup" && id) return cleanup(id);
  if (operation === "finalize" && id) return finalize(id);
  if (operation === "guest" && id) return guest(await readJob(id));
  if (operation === "admitted" && id) return admitted(await readJob(id));
  if (operation === "guard-control" && (id === "reject" || id === "timeout" || id === "cancel")) {
    if (!existsSync(base)) throw new Error("Prepare the offline base image first");
    return launch({ id: randomUUID(), profile: "native", prepare: false, control: true, argv: [`__guard-${id}__`] });
  }
  if (operation === "prepare") {
    validatePreparationTarget(id);
    if (process.argv.length !== 4) throw new Error("Unexpected preparation arguments");
    if (existsSync(base)) throw new Error("Offline base already exists");
    validatePreparationIdle(unitProperty("bun-wasm-ci-controller.service", "ActiveState"), unitProperty(outerUnit, "ActiveState"), (await readdir(`${root}/jobs`)).length);
    return launch({ id: randomUUID(), profile: "native", prepare: true, control: false, argv: ["bash", "-euc", "sudo apt-get --version >/dev/null; command -v setpriv; test \"$(node --version)\" = v26.13.1; test -n \"$ImageVersion\"; printf 'Ubuntu VM prerequisites passed\\n'"] });
  }
  if ((operation !== "run" && operation !== "control") || (id !== "native" && id !== "browser") || process.argv[4] !== "--" || process.argv.length < 6) throw new Error("Expected prepare, or run|control native|browser -- COMMAND...");
  if (!existsSync(base)) throw new Error("Prepare the offline base image first");
  await launch({ id: randomUUID(), profile: id, prepare: false, control: operation === "control", argv: process.argv.slice(5) });
}

if (process.argv[1] && resolve(process.argv[1]) === source) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "VM lifecycle failed"}\n`); process.exitCode = 1; });
}
