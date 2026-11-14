import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StorageLifetime, storageEvidence, storageStep } from "./storage-browser-evidence";
import { StoragePreservationFailure } from "../sandbox/tests/storage-browser";
import { handleStorageFailure } from "./storage-ci-quarantine";
import protocol from "./fixtures/storage-ci/webkit.json";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "bun-wasm-storage-evidence-"));
  directories.push(path);
  return path;
}

test("unselected observation performs no progress work and preserves the ordinary promise", async () => {
  const lifetime = storageEvidence(undefined);
  expect(lifetime.observation).toBeUndefined();
  const pending = Promise.resolve(42);
  expect(storageStep(undefined, "ordinary", () => pending)).toBe(pending);
  await lifetime.run(async () => {});
});

test("raw phase and original assertion survive before diagnostic collection can finish", async () => {
  const path = join(directory(), "progress.jsonl");
  const lifetime = storageEvidence(path);
  const original = new Error("original product assertion\nraw second line");
  await expect(lifetime.run(() => lifetime.step("assert-retained-source", () => { throw original; }))).rejects.toBe(original);
  const raw = readFileSync(path, "utf8");
  expect(raw).toContain('"kind":"begin"');
  expect(raw).toContain('"phase":"assert-retained-source"');
  expect(raw).toContain(JSON.stringify(original.stack));
  expect(raw).toContain('"kind":"primary-error"');
  lifetime.assertClean();
});

test("finally and timeout hook share exactly one resource cleanup", async () => {
  const lifetime = new StorageLifetime();
  let calls = 0;
  const release = lifetime.own("context.close", async () => { calls++; });
  await lifetime.run(release);
  await Promise.all([lifetime.cleanup(), release(), lifetime.cleanup()]);
  expect(calls).toBe(1);
});

test("a late acquisition closes once even after the hook began cleanup", async () => {
  const lifetime = new StorageLifetime();
  const opened = Promise.withResolvers<string>();
  let calls = 0;
  const acquiring = lifetime.acquire("browser.launch", () => opened.promise, async value => { expect(value).toBe("late browser"); calls++; });
  const cleaning = lifetime.cleanup();
  opened.resolve("late browser");
  const acquired = await acquiring;
  await Promise.all([cleaning, acquired.release()]);
  expect(calls).toBe(1);
});

test("the hook also waits for and blocks on a late acquisition's close failure", async () => {
  const lifetime = new StorageLifetime();
  const opened = Promise.withResolvers<string>();
  const secondary = new Error("late browser close failed");
  const acquiring = lifetime.acquire("browser.launch", () => opened.promise, async () => { throw secondary; });
  const cleaning = lifetime.cleanup();
  opened.resolve("late browser");
  await Promise.all([acquiring, cleaning]);
  expect(lifetime.failures).toEqual([secondary]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
});

test("cleanup failure blocks an otherwise successful body", async () => {
  const lifetime = new StorageLifetime();
  const failure = new Error("context close failed");
  lifetime.own("context.close", async () => { throw failure; });
  await expect(lifetime.run(async () => {})).rejects.toBeInstanceOf(AggregateError);
  expect(lifetime.failures).toEqual([failure]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
});

test("cleanup failure retains primary identity and remains a separate blocking hook failure", async () => {
  const path = join(directory(), "progress.jsonl");
  const lifetime = storageEvidence(path);
  const original = new Error("primary assertion");
  const secondary = new Error("session cleanup failed");
  lifetime.own("session.cleanup", async () => { throw secondary; });
  await expect(lifetime.run(async () => { throw original; })).rejects.toBe(original);
  expect(lifetime.failures).toEqual([secondary]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
  const raw = readFileSync(path, "utf8");
  expect(raw).toContain(JSON.stringify(original.stack));
  expect(raw).toContain(JSON.stringify(secondary.stack));
});

test("selected progress failure blocks before the operation and still cleans resources", async () => {
  const failure = new Error("progress disk failure");
  const lifetime = new StorageLifetime(() => { throw failure; });
  let ran = false;
  let closed = false;
  lifetime.own("session.cleanup", async () => { closed = true; });
  await expect(lifetime.run(() => lifetime.step("before-assertion", () => { ran = true; }))).rejects.toBe(failure);
  expect(ran).toBe(false);
  expect(closed).toBe(true);
  expect(lifetime.failures).toEqual([failure]);
});

test("report failure cannot replace a product error and cannot pass its hook", async () => {
  const original = new Error("primary assertion");
  const secondary = new Error("progress append failed");
  const lifetime = new StorageLifetime(event => { if (event.kind === "error") throw secondary; });
  await expect(lifetime.run(() => lifetime.step("assertion", () => { throw original; }))).rejects.toBe(original);
  expect(lifetime.failures).toEqual([secondary]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
});

for (const phase of ["context.close", "session.cleanup", "progress-report"]) test(`known quarantine plus ${phase} remains failing`, async () => {
  const path = directory();
  const original = new StoragePreservationFailure({ ...structuredClone(protocol), checkpoint: "vanilla-config-restart" }, new Error(protocol.error));
  const secondary = new Error(`${phase} failure`);
  const raw: unknown[] = [];
  const lifetime = new StorageLifetime(event => {
    raw.push(event);
    if (phase === "progress-report" && event.kind === "error") throw secondary;
  });
  if (phase !== "progress-report") lifetime.own(phase, async () => { throw secondary; });
  let accepted = false;
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try { await expect(lifetime.run(body)).rejects.toBeInstanceOf(AggregateError); }
  finally { warning.mockRestore(); }
  expect(accepted).toBe(true);
  expect(lifetime.failures).toEqual([secondary]);
  expect(() => lifetime.assertClean()).toThrow(AggregateError);
  expect(JSON.stringify(raw)).toContain(original.message);
  expect(readFileSync(join(path, "summary.md"), "utf8")).toContain("Storage quarantine");

  async function body(): Promise<void> {
    try { await lifetime.step("preservation", () => { throw original; }); }
    catch (error) {
      expect(error).toBe(original);
      await handleStorageFailure("webkit", error, { CI: "true", BUN_WASM_STORAGE_CI_QUARANTINE: "known-20261114", BUN_WASM_BROWSER_REPORT_DIR: path, GITHUB_STEP_SUMMARY: join(path, "summary.md") });
      accepted = true;
    }
  }
});

test("Bun whole-case timeout retains phases and runs owned hook cleanup once", () => {
  const path = directory();
  const progress = join(path, "progress.jsonl");
  const marker = join(path, "closed.txt");
  const fixture = join(path, "timeout.test.ts");
  const helper = new URL("./storage-browser-evidence.ts", import.meta.url).pathname;
  writeFileSync(fixture, `import { afterEach, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { storageEvidence } from ${JSON.stringify(helper)};
const lifetime = storageEvidence(${JSON.stringify(progress)});
lifetime.own("session.cleanup", async () => appendFileSync(${JSON.stringify(marker)}, "closed\\n"));
afterEach(async () => { await lifetime.cleanup(); lifetime.assertClean(); });
test("pending diagnostic", () => lifetime.run(() => lifetime.step("diagnostic.pending", () => new Promise(() => {}))), 50);
`);
  const run = Bun.spawnSync([process.execPath, "test", fixture], { timeout: 5000 });
  expect(run.signalCode).toBeUndefined();
  expect(run.exitCode).toBe(1);
  expect(new TextDecoder().decode(run.stderr)).toContain("timed out after 50ms");
  expect(readFileSync(marker, "utf8")).toBe("closed\n");
  const raw = readFileSync(progress, "utf8");
  expect(raw).toContain('"phase":"diagnostic.pending"');
  expect(raw).toContain('"kind":"cleanup-end"');
});
