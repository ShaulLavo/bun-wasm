import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserGuestRegression, browserGuestLeg, type RowEvidence } from "./browser-guest-regression";
import { rowIdentity } from "./browser-guest-catalogue";
import { linuxProcess } from "./process-owner.mts";

const cleanup = new Set<string>();
const owned = new Set<number>();
const controllers = new Set<AbortController>();
const pending = new Set<Promise<unknown>>();
afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(Array.from(pending));
  controllers.clear(); pending.clear();
  for (const pid of owned) {
    const row = linuxProcess(pid);
    if (!row || row.state === "Z") continue;
    process.kill(pid, "SIGKILL");
  }
  const cap = Date.now() + 10_000;
  while (Array.from(owned).some(pid => { const row = linuxProcess(pid); return row && row.state !== "Z"; })) {
    if (Date.now() > cap) throw new Error("Owned fixture failed to drain");
    await delay(20);
  }
  owned.clear();
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
  cleanup.clear();
});
function child(run: BrowserGuestRegression, request: Parameters<BrowserGuestRegression["runChild"]>[0]) {
  const controller = new AbortController(); controllers.add(controller);
  const result = run.runChild({ ...request, signal: request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal });
  pending.add(result); void result.catch(() => {});
  return result;
}
function regression(options: { controls?: string[] } = {}) {
  const directory = mkdtempSync("/work/tmp/bun-wasm-regression-"); cleanup.add(directory);
  const run = new BrowserGuestRegression({ owner: "worker-modules", leg: "chromium", engines: ["browser"], directory,
    controls: options.controls ?? [] });
  return { directory, run };
}
function evidence(run: BrowserGuestRegression): RowEvidence[] {
  return run.expected.map(row => ({ id: rowIdentity(row), status: "passed", detail: "Complete fixture assertions observed" }));
}
function request(mode: string, directory: string, run: BrowserGuestRegression) {
  return { command: [process.execPath, new URL("./fixtures/browser-guest-child.ts", import.meta.url).pathname, mode, join(directory, "descendant.pid")] as const,
    cwd: import.meta.dir, env: process.env, rows: run.expected, evidence: () => evidence(run) };
}
async function descendant(directory: string): Promise<number> {
  const path = join(directory, "descendant.pid"), cap = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > cap) throw new Error("Fixture descendant missing");
    await delay(10);
  }
  const pid = Number(readFileSync(path, "utf8")); owned.add(pid); return pid;
}

test("leg validation rejects ambient duplicate/extra browser dimensions", () => {
  expect(browserGuestLeg("chromium")).toBe("chromium"); expect(browserGuestLeg("webkit")).toBe("webkit");
  for (const value of [undefined, "", "firefox", "chromium,webkit", "chromium,chromium"]) expect(() => browserGuestLeg(value)).toThrow();
});
test("planned rows are durable before launch and a zero-row finalization fails", () => {
  const { directory, run } = regression();
  expect(JSON.parse(readFileSync(join(directory, "rows.json"), "utf8")).rows.every((row: { status: string }) => row.status === "planned")).toBe(true);
  expect(() => run.finish()).toThrow("coverage failed");
  expect(JSON.parse(readFileSync(join(directory, "rows.json"), "utf8")).rows.every((row: { status: string }) => row.status === "not-run")).toBe(true);
});
test("successful child drains detached descendants before return and passes exact row/control evidence", async () => {
  const { directory, run } = regression({ controls: ["controlled-iterations-1-20"] });
  const result = await child(run, request("pass", directory, run));
  const pid = await descendant(directory);
  expect(linuxProcess(pid)?.state ?? "Z").toBe("Z");
  expect(result.exitCode).toBe(0); expect(result.cleanup).toEqual({ kind: "drained" });
  expect(readFileSync(result.log, "utf8")).toContain("complete fixture assertions");
  expect(run.safeToReuse).toBe(true);
  run.recordControl({ id: "controlled-iterations-1-20", status: "passed", detail: "all iterations" });
  run.finish();
}, 30_000);
test("failed child drains descendants and retains every failed row", async () => {
  const { directory, run } = regression();
  const result = await child(run, request("fail", directory, run));
  const pid = await descendant(directory);
  expect(linuxProcess(pid)?.state ?? "Z").toBe("Z");
  expect(result.exitCode).toBe(7); expect(result.cleanup).toEqual({ kind: "drained" });
  expect(() => run.finish()).toThrow("coverage failed");
  const rows = JSON.parse(readFileSync(join(directory, "rows.json"), "utf8"));
  expect(rows.rows.every((row: { status: string }) => row.status === "failed")).toBe(true);
}, 30_000);
test("functional failure permits a disjoint next child only after descendant drain", async () => {
  const { directory, run } = regression();
  const first = run.expected.slice(0, 1), second = run.expected.slice(1);
  const failed = await child(run, { ...request("fail", directory, run), rows: first, evidence: () => evidence(run).slice(0, 1) });
  const pid = await descendant(directory);
  expect(linuxProcess(pid)?.state ?? "Z").toBe("Z"); expect(failed.cleanup).toEqual({ kind: "drained" });
  const passed = await child(run, { ...request("pass", directory, run), rows: second,
    command: [process.execPath, "-e", 'console.log("second independent child complete")'], evidence: () => evidence(run).slice(1) });
  expect(passed.exitCode).toBe(0); expect(run.safeToReuse).toBe(true);
  expect(() => run.finish()).toThrow();
}, 30_000);
test("cancellation is delivered through supervisor state and descendants drain before finalization", async () => {
  const { directory, run } = regression(), controller = new AbortController();
  const pending = child(run, { ...request("cancel", directory, run), signal: controller.signal });
  const pid = await descendant(directory); controller.abort();
  const result = await pending;
  expect(result.cancelled).toBe(true); expect(result.exitCode).toBe(143); expect(result.cleanup).toEqual({ kind: "drained" });
  expect(linuxProcess(pid)?.state ?? "Z").toBe("Z");
  expect(() => run.finish()).toThrow("coverage failed");
}, 30_000);
test("already-cancelled launch creates no guest descendants or passed rows", async () => {
  const { directory, run } = regression(), controller = new AbortController(); controller.abort();
  const result = await child(run, { ...request("cancel", directory, run), signal: controller.signal });
  expect(result.exitCode).toBe(143); expect(result.cleanup).toEqual({ kind: "drained" });
  expect(existsSync(join(directory, "descendant.pid"))).toBe(false);
  expect(() => run.finish()).toThrow();
});
test("zero-exit children cannot manufacture rows with no evidence", async () => {
  const { directory, run } = regression();
  await child(run, { ...request("pass", directory, run), evidence: () => [] });
  await descendant(directory);
  expect(() => run.finish()).toThrow();
  expect(JSON.parse(readFileSync(join(directory, "rows.json"), "utf8")).rows.every((row: { status: string }) => row.status === "not-run")).toBe(true);
}, 30_000);
for (const variant of ["duplicate", "foreign", "missing"] as const) {
  test(`${variant} row evidence remains red and does not alter the expected set`, async () => {
    const { directory, run } = regression();
    const rows = evidence(run), first = rows[0]; if (!first) throw new Error("Missing fixture row");
    const bad = variant === "duplicate" ? rows.concat([first]) : variant === "foreign" ? rows.concat([{ ...first, id: "unselected row" }]) : rows.slice(1);
    const pending = child(run, { ...request("pass", directory, run), evidence: () => bad });
    if (variant === "missing") await pending;
    else await expect(pending).rejects.toThrow("Unexpected/duplicate");
    await descendant(directory);
    expect(() => run.finish()).toThrow();
  }, 30_000);
}
test("unsafe supervisor exit blocks reuse and retains cleanup failure separately", async () => {
  const { directory, run } = regression();
  // No descendant is created: this owned child kills its supervisor, then exits itself.
  const result = await child(run, { ...request("pass", directory, run), command: [process.execPath, "-e", 'process.kill(process.ppid,"SIGKILL")'] });
  expect(result.cleanup.kind).toBe("unsafe"); expect(run.safeToReuse).toBe(false);
  await expect(child(run, request("pass", directory, run))).rejects.toThrow("safe child drain");
  expect(() => run.finish()).toThrow();
}, 30_000);
test("missing controls cannot be replaced by passed TSV rows", async () => {
  const { directory, run } = regression({ controls: ["all original controls"] });
  await child(run, request("pass", directory, run)); await descendant(directory);
  expect(() => run.finish()).toThrow();
}, 30_000);
