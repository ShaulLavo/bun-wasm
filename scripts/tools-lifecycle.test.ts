import { expect, setDefaultTimeout, test } from "bun:test";
import { ToolsLifecycle } from "../web/tests/tools-lifecycle.ts";
import { browserGuestOwnerInputs, browserGuestManifest } from "./browser-guest-selection";
import { readFileSync } from "node:fs";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test.each(["body", "deadline"])("Node imports tools diagnostics and flushes %s failure before cleanup exits", scenario => {
  const lifecycle = new URL("../web/tests/tools-lifecycle.ts", import.meta.url).href;
  const navigation = new URL("../web/tests/playground-navigation.ts", import.meta.url).href;
  // JavaScript is an intentional Node test input, exercising the driver's actual loader.
  const code = `import { ToolsLifecycle } from ${JSON.stringify(lifecycle)};
import ${JSON.stringify(navigation)};
const progress = new ToolsLifecycle();
const close = async () => process.exit(9);
if (${JSON.stringify(scenario)} === "body") {
  await progress.run(() => progress.step("ordinary-run", async () => { throw new Error("original body error"); }), close);
} else {
  void progress.step("ordinary-run", () => new Promise(() => {}));
  await progress.deadline(close);
}`;
  const result = Bun.spawnSync(["node", "--input-type=module", "-e", code], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(result.exitCode).toBe(9);
  const records = result.stderr.toString().trim().split("\n").map(line => JSON.parse(line));
  expect(records.map(record => record.event)).toEqual(["start", scenario === "body" ? "body-error" : "deadline", "cleanup-start"]);
  expect(records[1]).toMatchObject({ pending: "ordinary-run", completed: null });
  expect(records[1].error).toContain(scenario === "body" ? "original body error" : "five-minute guard");
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("body error and pending operation survive a cleanup that has not settled", async () => {
  const records: string[] = [], cleanup = deferred(), entered = deferred();
  const lifecycle = new ToolsLifecycle(record => { records.push(record); });
  lifecycle.select("chromium", "browser");
  const primary = new Error("original foreground failure");
  const result = lifecycle.run(() => lifecycle.step("ordinary-run", async () => { throw primary; }),
    () => { entered.resolve(); return cleanup.promise; });
  const failure = result.catch(error => error);
  try {
    await entered.promise;
    expect(records.map(record => JSON.parse(record).event)).toEqual(["start", "body-error", "cleanup-start"]);
    expect(JSON.parse(records[1]!)).toMatchObject({ browser: "chromium", engine: "browser", pending: "ordinary-run", completed: null });
    expect(JSON.parse(records[1]!).error).toBe(primary.stack);
  } finally { cleanup.resolve(); }
  expect(await failure).toBe(primary);
});

test("cleanup failure preserves the primary error as a separate blocking cause", async () => {
  const records: string[] = [], primary = new Error("body failed"), secondary = new Error("browser close failed");
  const lifecycle = new ToolsLifecycle(record => { records.push(record); });
  const error = await lifecycle.run(async () => { throw primary; }, async () => { throw secondary; }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, secondary]);
  expect(records.map(record => JSON.parse(record).event)).toEqual(["body-error", "cleanup-start", "cleanup-error"]);
});

test("cleanup failure blocks an otherwise successful body", async () => {
  const secondary = new Error("close failed"), lifecycle = new ToolsLifecycle(() => {});
  expect(await lifecycle.run(async () => {}, async () => { throw secondary; }).catch(error => error)).toBe(secondary);
});

test("guard records the actual outstanding operation before waiting for cleanup", async () => {
  const records: string[] = [], body = deferred(), cleanup = deferred();
  const lifecycle = new ToolsLifecycle(record => { records.push(record); });
  await lifecycle.step("server-start", async () => "http://127.0.0.1/");
  const active = lifecycle.step("wrong-payload-lint", () => body.promise);
  const expired = lifecycle.deadline(() => cleanup.promise);
  try {
    expect(records.map(record => JSON.parse(record).event)).toEqual(["start", "pass", "start", "deadline", "cleanup-start"]);
    expect(JSON.parse(records[3]!)).toMatchObject({ pending: "wrong-payload-lint", completed: "server-start" });
    expect(records.some(record => record.includes('"coverage"'))).toBe(false);
  } finally { body.resolve(); cleanup.resolve(); }
  await Promise.all([active, expired]);
});

test("guard cleanup rejection remains a failure with durable diagnostics", async () => {
  const records: string[] = [], error = new Error("guard close failed");
  const lifecycle = new ToolsLifecycle(record => { records.push(record); });
  expect(await lifecycle.deadline(async () => { throw error; }).catch(error => error)).toBe(error);
  expect(records.map(record => JSON.parse(record).event)).toEqual(["deadline", "cleanup-start", "cleanup-error"]);
});

test("successful cleanup records completion without rewriting the body operation", async () => {
  const records: string[] = [], lifecycle = new ToolsLifecycle(record => { records.push(record); });
  await lifecycle.run(async () => { await lifecycle.step("reload-lint", async () => 0); }, async () => {});
  expect(JSON.parse(records.at(-1)!)).toMatchObject({ event: "cleanup-complete", pending: "reload-lint", completed: "reload-lint" });
});

test("tools owns each imported diagnostic helper in its canonical manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../checks/browser-guest-tools-integrity.json", import.meta.url), "utf8"));
  expect(manifest).toEqual(browserGuestManifest("tools-integrity"));
  for (const helper of ["web/tests/tools-lifecycle.ts", "web/tests/tools-route.ts", "web/tests/playground-navigation.ts", "web/navigation-server-log.ts"]) {
    expect(browserGuestOwnerInputs("tools-integrity")).toContain(helper);
  }
});
