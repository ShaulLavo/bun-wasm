import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { launchProcess } from "./lifecycle-process";
import { baseMatrix, immutableIdentity, nextOutputs, validateLifecycle } from "./lifecycle-model";
import { verifyResolution } from "./lifecycle-lock";
import { bounded } from "../goals-matrix/bounded";
import { until } from "../goals-matrix/playground";
import { withSignals } from "../goals-matrix/lifetime";
import { resetNativeCache } from "./lifecycle-native";

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
