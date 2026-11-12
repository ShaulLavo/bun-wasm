import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { firefox } from "playwright";
import { canonical, object, treeInventory } from "./input";
import { processIdentity } from "./lifecycle-process";

async function save(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
export function lifecycleDriverInputs(root: string) {
  return { scripts: treeInventory(join(root, "scripts")), web: treeInventory(join(root, "web"), ["node_modules", "dist", "tests"]), environment: treeInventory(join(root, "env.sh")) };
}
export async function executableIdentity(path: string) {
  const resolved = await realpath(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolved)) hash.update(chunk);
  return { path, resolved, sha256: hash.digest("hex") };
}
async function runtimeIdentity(name: string) {
  const executable = Bun.which(name);
  if (!executable) throw new Error(`Missing comparison executable: ${name}`);
  return executableIdentity(executable);
}
export async function executionIdentity() {
  const chrome = process.env.GOALS_CHROME_EXECUTABLE;
  if (!chrome) throw new Error("Set GOALS_CHROME_EXECUTABLE to pin the genuine Chrome executable for comparison and resume");
  const firefoxExecutable = firefox.executablePath();
  const controller = await processIdentity(process.pid);
  if (!controller.available || !controller.allowedCPUs) throw new Error("Effective controller affinity unavailable for comparison identity");
  const packages = await Promise.all(["playwright", "playwright-core"].map(async name => {
    const root = await realpath(dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))));
    return { name, root, files: treeInventory(root, ["node_modules"]) };
  }));
  return { controller: await executableIdentity(process.execPath), controllerArgs: process.execArgv, native: { node: await runtimeIdentity("node"), bun: await runtimeIdentity("bun") },
    browsers: { chrome: await executableIdentity(chrome), firefox: await executableIdentity(firefoxExecutable), firefoxEngine: await executableIdentity(join(dirname(firefoxExecutable), "libxul.so")) },
    packages, kernel: release(), allowedCPUs: controller.allowedCPUs,
    browserEnvironment: Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "PLAYWRIGHT_BROWSERS_PATH", "GOALS_CHROME_EXECUTABLE", "MOZ_PROFILER_STARTUP", "MOZ_PROFILER_STARTUP_FILTERS", "MOZ_PROFILER_STARTUP_FEATURES", "LIBGL_ALWAYS_SOFTWARE"].map(key => [key, process.env[key] ?? null])),
    graphicsDriver: await readFile("/sys/module/nvidia/version", "utf8").then(value => value.trim()).catch(() => null) };
}
export function verifyResume(previous: unknown, current: unknown): void {
  if (canonical(previous) !== canonical(current)) throw new Error("Resume requires unchanged host, drivers, execution identities, fixtures, locks, inventories, mode and deadlines; use a new output directory");
}
export async function recordInvocationEnvironment(output: string, environment: unknown): Promise<string> {
  const invocation = join(output, "invocations", randomUUID());
  await mkdir(invocation, { recursive: true });
  await save(join(invocation, "environment.json"), environment);
  await writeFile(join(output, "environment.json"), JSON.stringify(environment, null, 2) + "\n", { flag: "wx" }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  await save(join(invocation, "host-verification.json"), { valid: null, reason: "Host verification pending" });
  return invocation;
}
export async function finalizeHostVerification(output: string, records: readonly string[], verificationPath: string, valid: boolean, reason: string): Promise<void> {
  const verification = { valid, reason, method: "complete staged-asset hashes before and after invocation" };
  await save(verificationPath, verification);
  await save(join(output, "host-verification.json"), verification);
  for (const path of records) {
    const run = object(JSON.parse(await readFile(path, "utf8")));
    const timing = object(run.timing);
    await save(path, { ...run, timing: { ...timing, valid: timing.eligible === true && valid, hostVerification: verificationPath, verificationReason: reason } });
  }
}
