import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { withSafariExitCapture, exitSettlementFile } from "./safari-exit-capture";
import { fakeNative, fakeSubscription } from "./safari-exit-fixture";
import { requireExitCaptureSettled } from "./fleet";
import { initialReport, options, runAutomaticNative } from "./run";
import { exitJSON } from "./safari-exit-sink";
import { discoverChecks, selectChecks } from "../test-checks";
import { needsRust } from "../ci-changes";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const root = await mkdtemp("/work/tmp/bun-wasm-exit-capture-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  if (process.env.LIFECYCLE_DIRECTORY_LEDGER) await appendFile(process.env.LIFECYCLE_DIRECTORY_LEDGER, root + "\n");
  return root;
}

test("production capture writes complete final evidence after teardown, preserving original failure identity", async () => {
  const root = await directory();
  const native = fakeNative(), fake = fakeSubscription();
  const original = new Error("original operation error");
  const result = await withSafariExitCapture(root, owner => owner.attempt(async () => {
    owner.attach({ pid: 101, birth: "7" });
    throw original;
  }, [{ phase: "app-teardown", run: async () => { fake.event(); } }]), async () => ({ native: native.native, open: () => fake.subscription })).catch(error => error);
  expect(result).toBe(original);
  const logs = join(root, "logs");
  const receipt = JSON.parse(await readFile(join(logs, exitSettlementFile), "utf8"));
  expect(receipt).toMatchObject({ state: "settled", descriptor: "closed", childrenJoined: true, writersClosed: true, eventCount: 1 });
  expect(() => requireExitCaptureSettled(receipt)).not.toThrow();
  const entries: unknown[] = (await readFile(join(logs, receipt.file), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(entries).toContainEqual(expect.objectContaining({ kind: "exit-poll", phase: "app-teardown", target: { pid: 101, birth: "7" }, value: expect.objectContaining({ kind: "event" }) }));
  expect(fake.closes).toBe(1);
});

test("partial adapter construction leaves an open unproved receipt and creates no writer or target subscription", async () => {
  const root = await directory();
  const failure = new Error("adapter failed");
  const result = await withSafariExitCapture(root, async () => { throw new Error("operation ran"); }, async () => { throw failure; }).catch(error => error);
  expect(result).toBe(failure);
  expect(await readdir(join(root, "logs"))).toEqual([exitSettlementFile]);
  expect(JSON.parse(await readFile(join(root, "logs", exitSettlementFile), "utf8"))).toMatchObject({ state: "open" });
});

test("fleet requires final observer joins and close in addition to the existing inner capture receipt", () => {
  const valid = { state: "settled", descriptor: "closed", childrenJoined: true, cleanupCompleted: true, writersJoined: true, writersClosed: true, adapterClosed: true };
  expect(() => requireExitCaptureSettled(valid)).not.toThrow();
  expect(() => requireExitCaptureSettled(null)).not.toThrow();
  for (const key of Object.keys(valid)) expect(() => requireExitCaptureSettled({ ...valid, [key]: null })).toThrow("unproved");
  expect(() => requireExitCaptureSettled(undefined)).toThrow("unproved");
});

test("error evidence serializes primary and cleanup failures separately without changing their objects", () => {
  const primary = Object.assign(new Error("registration failed"), { evidence: { errno: 13 }, cleanup: new Error("close failed") });
  expect(JSON.parse(exitJSON(primary))).toMatchObject({ name: "Error", message: "registration failed", evidence: { errno: 13 }, cleanup: { name: "Error", message: "close failed" } });
});

test("adapter disposal failure is separate from the original operation and leaves final settlement unproved", async () => {
  const root = await directory();
  const native = fakeNative(), fake = fakeSubscription();
  const original = new Error("original operation");
  const result = await withSafariExitCapture(root, async owner => {
    owner.attach({ pid: 101, birth: "7" });
    throw original;
  }, async () => ({ native: native.native, open: () => fake.subscription, dispose() { throw new Error("library close failed"); } })).catch(error => error);
  expect(result).toBe(original);
  expect(JSON.parse(await readFile(join(root, "logs", exitSettlementFile), "utf8"))).toMatchObject({ state: "unproved", descriptor: "closed", adapterClosed: false, adapterFailure: { message: "library close failed" } });
  expect(fake.closes).toBe(1);
});

test.each([false, true])("automatic native caller enables the outer owner only for existing causal opt-in %s", async enabled => {
  const root = await directory();
  const args = [`--root=${root}`, `--output=${root}`, "--asset-source=unit-no-assets", "--browsers=safari", "--engines=quickjs", "--frameworks=next"].concat(enabled ? ["--safari-causal-capture"] : []);
  const config = options(args);
  const expected = await initialReport(config);
  const native = fakeNative(), fake = fakeSubscription();
  let captures = 0, campaigns = 0;
  const result = await runAutomaticNative(config, {
    capture: (output, operation) => { captures++; return withSafariExitCapture(output, operation, async () => ({ native: native.native, open: () => fake.subscription })); },
    driver: async (operation, driverConfig) => {
      expect(Boolean(driverConfig.exitOwner)).toBe(enabled);
      expect(driverConfig.desktopSafari).toBe(true);
      return operation("http://127.0.0.1:12345", new AbortController().signal);
    },
    campaign: async (received, owner) => {
      campaigns++;
      expect(received.safariEndpoint).toBe("http://127.0.0.1:12345");
      expect(Boolean(owner)).toBe(enabled);
      owner?.attach({ pid: 101, birth: "7" });
      return expected;
    },
  });
  expect(result).toBe(expected);
  expect(captures).toBe(enabled ? 1 : 0);
  expect(campaigns).toBe(1);
  expect(fake.closes).toBe(enabled ? 1 : 0);
  if (!enabled) expect(await readdir(root)).toEqual([]);
});

test("source-only exit controls have one blocking Web owner without selecting native producers", () => {
  const paths = ["safari-exit-capture", "safari-exit-observer", "safari-exit-syscalls", "safari-native-exit"].map(name => `scripts/goals-matrix/${name}.test.ts`);
  const checks = discoverChecks().filter(check => paths.includes(check.path));
  expect(checks).toHaveLength(paths.length);
  expect(checks.every(check => check.owner === "web" && check.localRuntime)).toBe(true);
  expect(selectChecks("web")).toContainValues(paths);
  expect(needsRust(paths.concat(["scripts/goals-matrix/native.ts", "scripts/goals-matrix/run.ts", "scripts/goals-matrix/safari-exit-native.ts"]))).toBe(false);
});
