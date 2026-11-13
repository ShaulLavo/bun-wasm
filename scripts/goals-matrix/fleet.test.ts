import { chmod, mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadlinePolicy } from "./deadlines";
import { test, expect } from "bun:test";
import { nativePlatformBlocker, blockedCell } from "./platform";
import { combine, collectNativeReport, cleanupStaging } from "./fleet";
import { options } from "./run";
import { initialCells, finish, phases, type Report, type Attempt } from "./model";
function report(): Report { return { schema: 2, run: "unit", createdAt: "unit", command: "unit", deadlines: deadlinePolicy(180_000), source: { commit: "unit", dirty: false, assets: {} }, cells: initialCells() }; }
test("merging disjoint shards retains failures and all pending and unavailable boxes", () => {
  const first = report(), second = report();
  const failed: Attempt = { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "dev", status: "fail", error: "real failure", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] };
  first.cells[0] = finish(first.cells[0]!, failed);
  const merged = combine(first, second);
  expect(merged.cells).toHaveLength(208);
  expect(merged.cells[0]).toMatchObject({ status: "fail", error: "real failure" });
  second.cells[0] = finish(second.cells[0]!, { ...failed, startedAt: "another", phases: [{ phase: "dev", status: "fail", error: "other failure", startedAt: "another", durationMs: 1, timeoutMs: 180_000 }] });
  expect(() => combine(first, second)).toThrow("Overlapping");
});
test("shards cannot relabel different source or assets as one run", () => {
  const first = report(), second = report(); second.source.commit = "another";
  expect(() => combine(first, second)).toThrow("sources");
});
test("a WebKit result cannot be published as real Safari or Chrome", () => {
  const attempt: Attempt = { startedAt: "now", finishedAt: "now", browser: { browserName: "webkit" }, phases: phases.map(phase => ({ phase, status: "pass", evidence: {}, startedAt: "now", durationMs: 1, timeoutMs: 180_000 })) };
  for (const browser of ["chrome", "safari", "iphone-safari"] as const) expect(() => finish({ framework: "next", browser, engine: "browser" }, attempt)).toThrow("Wrong browser");
});

test("continuation merges identical history once and preserves earlier failed attempts", () => {
  const first = report(), second = report();
  const failed: Attempt = { startedAt: "first", finishedAt: "first", browser: {}, phases: [{ phase: "dev", status: "fail", error: "original failure", startedAt: "first", durationMs: 1, timeoutMs: 180_000 }] };
  const box = first.cells[0]!;
  first.cells[0] = finish(box, failed);
  second.cells[0] = finish(box, { ...failed, startedAt: "retry" }, [failed]);
  const merged = combine(first, second);
  expect(merged.cells[0]?.attempts).toHaveLength(2);
  expect(merged.cells[0]?.attempts[0]?.phases[0]).toMatchObject({ error: "original failure" });
});

test("native platform discovery never erases an attempted failure or invents attempts", () => {
  const failed = finish({ framework: "next", browser: "safari", engine: "browser" }, { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "startup", status: "fail", error: "session not created: RWIApplication", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] });
  const blocker = nativePlatformBlocker(failed);
  expect(blocker).toBeDefined();
  if (!blocker) throw new Error("Expected native platform blocker");
  const blockers = new Map([["safari", blocker]] as const);
  expect(blockedCell(failed, blockers)).toBeUndefined();
  const pending = { framework: "nuxt", browser: "safari", engine: "browser", attempts: [], status: "pending", reason: "not attempted" } as const;
  expect(blockedCell({ ...pending, attempts: [] }, blockers)).toMatchObject({ status: "not runnable yet", attempts: [], discovery: { error: "session not created: RWIApplication" } });
});


test("pre-driver failure without attempts collects its report and cleanup without terminal logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-collection-"));
  try {
    const collected = join(root, "collected"), output = join(root, "output");
    await mkdir(collected); await mkdir(output);
    const native = report();
    native.cells[0] = { ...native.cells[0]!, status: "not runnable yet", reason: "setup failed", attempts: [], discovery: { error: "prelaunch ownership unproved" } };
    const cleanup = { driverExited: true, safariExited: false, lockRemoved: false };
    await writeFile(join(collected, "TABLE.json"), JSON.stringify(native));
    await writeFile(join(collected, "native-cleanup.json"), JSON.stringify(cleanup));
    expect(await collectNativeReport(collected, output)).toEqual(native);
    expect(JSON.parse(await readFile(join(output, "native-cleanup.json"), "utf8"))).toEqual(cleanup);
  } finally { await rm(root, { recursive: true, force: true }); }
});


async function collectionFixture(operation: (collected: string, output: string, native: Report) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-collection-"));
  try {
    const collected = join(root, "collected"), output = join(root, "output");
    await mkdir(collected); await mkdir(output);
    await writeFile(join(collected, "native-cleanup.json"), JSON.stringify({ driverExited: false, lockRemoved: false }));
    await operation(collected, output, report());
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("attempted native cells still require their terminal logs directory", async () => {
  await collectionFixture(async (collected, output, native) => {
    native.cells[0] = finish(native.cells[0]!, { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "startup", status: "fail", error: "session failed", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] });
    await writeFile(join(collected, "TABLE.json"), JSON.stringify(native));
    await expect(collectNativeReport(collected, output)).rejects.toThrow("ENOENT");
  });
});
test("an invalid report cannot authorize missing logs", async () => {
  await collectionFixture(async (collected, output, native) => {
    await writeFile(join(collected, "TABLE.json"), JSON.stringify({ ...native, cells: [] }));
    await expect(collectNativeReport(collected, output)).rejects.toThrow("208");
  });
});
test("zero attempted cells still require the native cleanup receipt", async () => {
  await collectionFixture(async (collected, output, native) => {
    await writeFile(join(collected, "TABLE.json"), JSON.stringify(native));
    await rm(join(collected, "native-cleanup.json"));
    await expect(collectNativeReport(collected, output)).rejects.toThrow("ENOENT");
  });
});

const meshFixture = `import { cpSync, existsSync, rmSync } from "node:fs";
const args = process.argv.slice(2);
const remote = process.env.SAFARI_SALVAGE_REMOTE;
if (!remote) throw new Error("Missing fixture root");
if (args[0] === "cp") cpSync(args[2].replace(/^mac:/, ""), args[3], { recursive: true });
else if (args[0] === "ssh" && args[4] === "-lc") {
  if (args[5].includes("queue-exit")) console.log(JSON.stringify({ holder: null, waiting: [] }));
  else console.log(JSON.stringify({ workloadStarted: true, capture: null, cleanup: { driverExited: true, safariExited: true, admissionOwner: "installed-mac-queue" } }));
} else if (args[3] === "rm") rmSync(remote, { recursive: true });
else if (args[3] === "test") process.exitCode = existsSync(remote) ? 1 : 0;
else throw new Error("Unexpected fixture operation");
`;

async function salvageFixture(mode: "interrupted" | "copy-failed" | "incomplete"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-salvage-"));
  const remote = join(root, "remote"), output = join(root, "output"), bin = join(root, "bin");
  const originalPath = process.env.PATH, originalRemote = process.env.SAFARI_SALVAGE_REMOTE;
  try {
    await mkdir(bin); await mkdir(output); await mkdir(join(remote, "report/logs"), { recursive: true });
    await writeFile(join(root, "mesh.ts"), meshFixture);
    await writeFile(join(bin, "mesh"), `#!/bin/sh\nexec '${process.execPath}' '${join(root, "mesh.ts")}' "$@"\n`);
    await chmod(join(bin, "mesh"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.SAFARI_SALVAGE_REMOTE = remote;
    const native = report();
    native.cells[0] = finish(native.cells[0]!, { startedAt: "now", finishedAt: "now", browser: {}, phases: [{ phase: "startup", status: "fail", error: "native result", startedAt: "now", durationMs: 1, timeoutMs: 180_000 }] });
    await writeFile(join(output, "TABLE.json"), JSON.stringify(report()));
    await writeFile(join(remote, "report/TABLE.json"), JSON.stringify(native));
    await writeFile(join(remote, "report/logs/owned.jsonl"), "final acknowledgement\n");
    if (mode !== "incomplete") await writeFile(join(remote, "report/native-cleanup.json"), JSON.stringify({ driverExited: true }));
    const config = options(["--asset-source=fixture", "--safari-ownership", `--output=${output}`]);
    const cleanup = cleanupStaging(remote, true, config, new Error(mode));
    if (mode === "incomplete") { await expect(cleanup).rejects.toThrow(); expect(await Bun.file(join(remote, "report/TABLE.json")).exists()).toBe(true); return; }
    await cleanup;
    expect(await Bun.file(join(remote, "report/TABLE.json")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(output, "TABLE.json"), "utf8")).cells[0].attempts).toEqual(native.cells[0]!.attempts);
    expect(await Bun.file(join(output, "TABLE.md")).exists()).toBe(true);
    expect(await readFile(join(output, "logs/owned.jsonl"), "utf8")).toContain("final acknowledgement");
    expect(JSON.parse(await readFile(join(output, "native-cleanup.json"), "utf8"))).toEqual({ driverExited: true });
  } finally {
    process.env.PATH = originalPath;
    if (originalRemote === undefined) delete process.env.SAFARI_SALVAGE_REMOTE;
    else process.env.SAFARI_SALVAGE_REMOTE = originalRemote;
    await rm(root, { recursive: true, force: true });
  }
}

test("exceptional native collection preserves TABLE history, logs and cleanup before removing staging", async () => {
  await salvageFixture("interrupted");
  await salvageFixture("copy-failed");
  await salvageFixture("incomplete");
});
