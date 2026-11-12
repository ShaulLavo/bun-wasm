import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { launchProcess } from "./lifecycle-process";
import { baseMatrix, immutableIdentity, nextOutputs, validateLifecycle } from "./lifecycle-model";
import { verifyResolution } from "./lifecycle-lock";
import { bounded } from "../goals-matrix/bounded";
import { until } from "../goals-matrix/playground";
import { withSignals } from "../goals-matrix/lifetime";
import { nativeLifecycle, resetNativeCache } from "./lifecycle-native";
import { summarizeLifecycle } from "./lifecycle-summary";
import { sha256 } from "./input";
import { executableIdentity, finalizeHostVerification, lifecycleDriverInputs, recordInvocationEnvironment, verifyResume } from "./lifecycle-campaign";
import { beginExecutionInterval } from "./lifecycle-evidence";

test("execution intervals distinguish incomplete startup from a completed monotonic bracket", () => {
  const observations = new Map<string, unknown>();
  const finish = beginExecutionInterval((name, value) => { observations.set(name, value); }, "startup", "readiness envelope");
  expect(observations.get("startup")).toMatchObject({ kind: "pending", unit: "ms", reason: "Interval did not reach completion" });
  const before = observations.get("startup");
  finish();
  expect(observations.get("startup")).toMatchObject({ kind: "completed", unit: "ms", scope: "readiness envelope" });
  if (!before || typeof before !== "object" || !("beforeMs" in before) || typeof before.beforeMs !== "number") throw new Error("Missing startup beginning");
  const completed = observations.get("startup");
  if (!completed || typeof completed !== "object" || !("afterMs" in completed) || typeof completed.afterMs !== "number") throw new Error("Missing startup completion");
  expect(completed.afterMs).toBeGreaterThanOrEqual(before.beforeMs);
});

const fixture = resolve(import.meta.dir, "fixtures/lifecycle-process.ts");
test("shared matrix contains 10 Next and 12 Vite cells with matched native preview browsers", () => {
  const cells = baseMatrix();
  expect(cells).toHaveLength(22);
  expect(new Set(cells.map(cell => cell.id)).size).toBe(22);
  expect(cells.filter(cell => cell.workload === "next")).toHaveLength(10);
  expect(cells.filter(cell => cell.workload === "vite" && cell.arm.kind === "native").map(cell => cell.id)).toEqual(["vite-native-node-chrome", "vite-native-node-firefox", "vite-native-bun-chrome", "vite-native-bun-firefox"]);
});
test("immutable inputs reject source mutation while declared output caches may change", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-input-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    const before = immutableIdentity(root, "next");
    await mkdir(join(root, ".next"));
    await writeFile(join(root, ".next/build"), "generated");
    expect(immutableIdentity(root, "next")).toBe(before);
    expect((await resetNativeCache(root, "next")).absent).toBe(true);
    expect(await stat(join(root, ".next")).then(() => true).catch(() => false)).toBe(false);
    await writeFile(join(root, "package.json"), '{"changed":true}');
    expect(immutableIdentity(root, "next")).not.toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("selection preload preserves omitted and explicit dlopen flags and arms its Wasm control", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-selection-"));
  const output = join(root, "selection.jsonl");
  const job = launchProcess([process.execPath, fixture, "selection", root], root, { ...process.env, LIFECYCLE_SELECTION_OUTPUT: output }, root);
  try {
    expect(await job.exited).toBe(0);
    expect(JSON.parse(await readFile(join(root, "arities.json"), "utf8"))).toEqual([2, 3]);
    const events = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.phase === "control" && event.kind === "wasm-instantiate")).toBe(true);
  } finally { await job.close(); await rm(root, { recursive: true, force: true }); }
});
test("guest lock metadata may differ but package versions and integrity stay frozen", () => {
  const lock = (version: string, integrity: string, libc: string | null) => JSON.stringify({ workspaces: { "": {} }, packages: { pkg: [version, "", libc ? { libc } : {}, integrity] } });
  expect(verifyResolution(lock("pkg@1", "sha512-a", "glibc"), lock("pkg@1", "sha512-a", null)).sameResolution).toBe(true);
  expect(() => verifyResolution(lock("pkg@1", "sha512-a", null), lock("pkg@2", "sha512-a", null))).toThrow("resolutions");
  expect(() => verifyResolution(lock("pkg@1", "sha512-a", null), lock("pkg@1", "sha512-b", null))).toThrow("integrity");
});
async function finite(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-exit-"));
  const job = launchProcess([process.execPath, fixture, mode, root], root, process.env, root);
  try {
    const exitCode = await job.exited;
    const outputs = await Promise.all(nextOutputs.map(async path => ({ path, bytes: await stat(join(root, path)).then(value => value.size).catch(() => 0) })));
    return { kind: "next", exitCode, outputs } as const;
  } finally { await job.close(); await rm(root, { recursive: true, force: true }); }
}
test("real exit and output checks reject both nonzero builds and successful empty builds", async () => {
  validateLifecycle(await finite("outputs"));
  const failed = await finite("fail"), empty = await finite("empty");
  expect(() => validateLifecycle(failed)).toThrow();
  expect(() => validateLifecycle(empty)).toThrow();
});
function live(pid: number): Promise<boolean> {
  return readFile(`/proc/${pid}/stat`, "utf8").then(text => text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z").catch(() => false);
}
test("timeout cleanup stops the owned process group including a descendant that ignores SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-cleanup-"));
  const job = launchProcess([process.execPath, fixture, "descendant", root], root, process.env, root);
  let descendant: number | undefined;
  try {
    descendant = await until(async () => Number(await readFile(join(root, "child.pid"), "utf8").catch(() => "0")), value => value > 0, 3000);
    expect(await live(descendant)).toBe(true);
    await expect(bounded(() => job.exited, 20)).rejects.toThrow();
  } finally { await job.close(); await rm(root, { recursive: true, force: true }); }
  if (descendant === undefined) throw new Error("Descendant was not observed");
  const pid = descendant;
  expect(await until(() => live(pid), value => !value, 1000)).toBe(false);
});
test("Vite requires zero-to-one transition and ordered observation brackets", () => {
  const bracket = { beforeMs: 1, afterMs: 2 };
  const outcome = { kind: "vite", listening: bracket, rendered: bracket, counter: bracket, before: "count is 0", after: "count is 1" } as const;
  validateLifecycle(outcome);
  expect(() => validateLifecycle({ ...outcome, after: "count is 0" })).toThrow("counter");
  expect(() => validateLifecycle({ ...outcome, counter: { beforeMs: 2, afterMs: 1 } })).toThrow("bracket");
});
test("signal cancellation reaches teardown and stops the owned descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-signal-"));
  let descendant: number | undefined;
  try {
    await expect(withSignals(async signal => {
      const job = launchProcess([process.execPath, fixture, "descendant", root], root, process.env, root);
      try {
        descendant = await until(async () => Number(await readFile(join(root, "child.pid"), "utf8").catch(() => "0")), value => value > 0, 3000);
        process.kill(process.pid, "SIGTERM");
        await bounded(() => job.exited, 3000, signal);
      } finally { await job.close(); }
    })).rejects.toThrow("interrupted");
    if (descendant === undefined) throw new Error("Descendant was not observed");
    const pid = descendant;
    expect(await until(() => live(pid), value => !value, 1000)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed native adapter retains acquired execution evidence after timeout and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-evidence-"));
  const prepared = join(root, "prepared");
  const output = join(root, "output");
  const script = "setInterval(() => {}, 1000);";
  try {
    await mkdir(output);
    await mkdir(prepared);
    await cp("sandbox/template-next", join(prepared, "next"), { recursive: true });
    await mkdir(join(prepared, "next/node_modules/next/dist/bin"), { recursive: true });
    await writeFile(join(prepared, "next/node_modules/next/dist/bin/next"), script);
    await writeFile(join(prepared, "next-inventory.json"), JSON.stringify({ files: [{ path: "next/dist/bin/next", sha256: sha256(script) }] }));
    const cell = baseMatrix().find(cell => cell.id === "next-native-bun");
    if (!cell) throw new Error("Missing native test cell");
    await expect(nativeLifecycle(cell, prepared, root, output, 40, new AbortController().signal)).rejects.toThrow();
    const evidence = JSON.parse(await readFile(join(output, "execution.json"), "utf8"));
    expect(evidence.status).toBe("failed");
    expect(evidence.observations.command.kind).toBe("observed");
    expect(evidence.observations.actualProcess.value.available).toBe(true);
    expect(evidence.observations.reset.value.absent).toBe(true);
    expect(evidence.observations.inputs.value.before).toBeString();
    expect(evidence.observations.completion.kind).toBe("unavailable");
    expect(JSON.parse(await readFile(join(output, "cleanup.json"), "utf8")).resourcesStopped).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("summary respects explicit timing invalidity and applicable host verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-summary-"));
  const source = join(root, "source");
  const output = join(root, "summary");
  const id = "next-native-node";
  const record = join(source, id, "run.json");
  const sources = new Map([[id, record]]);
  const run = { workloadOutcome: { status: "pass" }, result: { inputs: { valid: true }, wallMs: 1 }, observation: { kind: "timing" }, timing: { valid: true } };
  const row = async () => JSON.parse(await readFile(join(output, "summary.json"), "utf8")).rows.find((entry: { id: string }) => entry.id === id);
  try {
    await mkdir(join(source, id), { recursive: true });
    await mkdir(output);
    await writeFile(record, JSON.stringify(run));
    await writeFile(join(source, "host-verification.json"), JSON.stringify({ valid: false }));
    await summarizeLifecycle(output, sources);
    expect((await row()).timingValid).toBe(false);
    await writeFile(join(source, "host-verification.json"), JSON.stringify({ valid: true }));
    await summarizeLifecycle(output, sources);
    expect((await row()).timingValid).toBe(true);
    await writeFile(record, JSON.stringify({ ...run, timing: { valid: false } }));
    await summarizeLifecycle(output, sources);
    expect((await row()).timingValid).toBe(false);
    await rm(join(source, "host-verification.json"));
    await writeFile(record, JSON.stringify(run));
    await summarizeLifecycle(output, sources);
    expect((await row()).timingValid).toBe(false);
    const verification = join(source, "specific-verification.json");
    await writeFile(verification, JSON.stringify({ valid: true }));
    await writeFile(record, JSON.stringify({ ...run, timing: { valid: true, hostVerification: verification } }));
    await summarizeLifecycle(output, sources);
    expect((await row()).timingValid).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resume rejects changed shared drivers and execution identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-resume-"));
  try {
    await mkdir(join(root, "scripts/goals-matrix"), { recursive: true });
    await mkdir(join(root, "web"));
    await writeFile(join(root, "scripts/goals-matrix/transport.ts"), "first driver");
    await writeFile(join(root, "web/serve.ts"), "server");
    await writeFile(join(root, "env.sh"), "environment");
    await writeFile(join(root, "runtime"), "first executable");
    const previous = { drivers: lifecycleDriverInputs(root), execution: await executableIdentity(join(root, "runtime")) };
    expect(() => verifyResume(previous, previous)).not.toThrow();
    await writeFile(join(root, "scripts/goals-matrix/transport.ts"), "changed driver");
    expect(() => verifyResume(previous, { ...previous, drivers: lifecycleDriverInputs(root) })).toThrow("Resume");
    await writeFile(join(root, "runtime"), "changed executable");
    const execution = await executableIdentity(join(root, "runtime"));
    expect(() => verifyResume(previous, { ...previous, execution })).toThrow("Resume");
    expect(() => verifyResume({ affinity: "0-15" }, { affinity: "0-27" })).toThrow("Resume");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invocations preserve earlier environments and finalize affected timing validity", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-lifecycle-verification-"));
  const record = join(root, "run.json");
  const run = { workloadOutcome: { status: "pass" }, timing: { eligible: true, valid: null } };
  try {
    const first = await recordInvocationEnvironment(root, { label: "first" });
    const second = await recordInvocationEnvironment(root, { label: "second" });
    expect(JSON.parse(await readFile(join(root, "environment.json"), "utf8"))).toEqual({ label: "first" });
    expect(JSON.parse(await readFile(join(first, "environment.json"), "utf8"))).toEqual({ label: "first" });
    expect(JSON.parse(await readFile(join(second, "environment.json"), "utf8"))).toEqual({ label: "second" });
    expect(JSON.parse(await readFile(join(second, "host-verification.json"), "utf8")).valid).toBeNull();
    await writeFile(record, JSON.stringify(run));
    await finalizeHostVerification(root, [record], join(second, "host-verification.json"), false, "Host changed");
    const invalid = JSON.parse(await readFile(record, "utf8"));
    expect(invalid.workloadOutcome.status).toBe("pass");
    expect(invalid.timing.valid).toBe(false);
    expect(invalid.timing.hostVerification).toBe(join(second, "host-verification.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
