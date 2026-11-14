import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoragePreservationFailure } from "../sandbox/tests/storage-browser";
import { handleStorageFailure, storageQuarantine } from "./storage-ci-quarantine";
import firefoxProtocol from "./fixtures/storage-ci/firefox.json";
import webkitProtocol from "./fixtures/storage-ci/webkit.json";

type Report = StoragePreservationFailure["report"];
type PageDiagnostic = Exclude<Report["pages"][number], string>;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function failure(browser: string, patch: Partial<Report> = {}): StoragePreservationFailure {
  const protocol = structuredClone(browser === "firefox" ? firefoxProtocol : webkitProtocol);
  const checkpoint = browser === "firefox" ? "first-vite-vue-startup" : "vanilla-config-restart";
  return new StoragePreservationFailure({ checkpoint, ...protocol, ...patch }, new Error(protocol.error));
}

function target(report: Report, patch: Partial<PageDiagnostic>): Report["pages"] {
  const [active, page] = report.pages;
  if (!active || !page || typeof page === "string") throw new Error("Missing diagnostic fixture");
  return [active, { ...page, ...patch }];
}

async function evidence(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-storage-ci-"));
  directories.push(directory);
  return {
    CI: "true", BUN_WASM_STORAGE_CI_QUARANTINE: "known-20261114",
    BUN_WASM_BROWSER_REPORT_DIR: directory, GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  };
}

test("original Firefox and WebKit protocols match only their explicit source checkpoints", () => {
  expect(storageQuarantine("firefox", failure("firefox"))).toBe("firefox-first-vue-closed");
  expect(storageQuarantine("webkit", failure("webkit"))).toBe("webkit-vanilla-config-restart");
});

for (const browser of ["firefox", "webkit"]) {
  test(`${browser}: other browsers, checkpoints, errors, and incomplete diagnostics remain blocking`, () => {
    const original = failure(browser);
    const report = original.report;
    const page = report.pages[1];
    if (!page || typeof page === "string") throw new Error("Invalid fixture");
    expect(storageQuarantine("chromium", original)).toBeUndefined();
    expect(storageQuarantine(browser === "firefox" ? "webkit" : "firefox", original)).toBeUndefined();
    const variants: Partial<Report>[] = [
      { checkpoint: "setup" }, { checkpoint: "preservation" },
      { checkpoint: browser === "firefox" ? "vanilla-config-restart" : "first-vite-vue-startup" },
      { error: "AssertionError: active workspace was evicted" },
      { error: "Error: restored source HMR replaced the document" },
      { errors: report.errors.concat("unknown transport failure") },
      { pages: [] }, { pages: ["closed", "missing"] },
      { pages: target(report, { runtime: null }) },
      { pages: target(report, { frames: [] }) },
      { pages: target(report, { url: "http://127.0.0.1:1/sandbox/?template=other&engine=browser" }) },
      { pages: target(report, { status: "unknown failure" }) },
      { pages: target(report, { terminal: "FilesystemTransportError: CLOSED" }) },
      { pages: target(report, { terminal: page.terminal.replace("errno=29", "errno=30").replace("ready in", "failed in") }) },
      { pages: target(report, { terminal: `${page.terminal}\nunknown fatal error` }) },
    ];
    for (const patch of variants) expect(storageQuarantine(browser, failure(browser, patch))).toBeUndefined();
  });

  test(`${browser}: a failed active Hono control, pending editor, or failed filesystem remains blocking`, () => {
    const report = failure(browser).report;
    const [active, page] = report.pages;
    if (!active || !page || typeof active === "string" || typeof page === "string" || !page.runtime) throw new Error("Invalid fixture");
    expect(storageQuarantine(browser, failure(browser, { pages: [{ ...active, status: "stopped" }, page] }))).toBeUndefined();
    expect(storageQuarantine(browser, failure(browser, { pages: [{ ...active, frames: [] }, page] }))).toBeUndefined();
    expect(storageQuarantine(browser, failure(browser, { pages: [{ ...active, frames: [{ ...active.frames[0]!, body: "Hello from hono\nIncrement0" }] }, page] }))).toBeUndefined();
    expect(storageQuarantine(browser, failure(browser, { pages: target(report, { runtime: { ...page.runtime, pending: true } }) }))).toBeUndefined();
    expect(storageQuarantine(browser, failure(browser, { pages: target(report, { runtime: { ...page.runtime, filesystem: { status: "failed", error: "CLOSED" } } }) }))).toBeUndefined();
  });

  test(`${browser}: matching failure retains the complete protocol and labels the quarantine`, async () => {
    const env = await evidence();
    const original = failure(browser);
    const warnings = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleStorageFailure(browser, original, env);
      expect(warnings.mock.calls[0]?.[0]).toContain("::warning title=Storage quarantine::");
    } finally { warnings.mockRestore(); }
    const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, `sandbox-storage-${browser}-preservation.json`), "utf8"));
    expect(saved).toEqual({ browser, quarantine: storageQuarantine(browser, original), ...original.report });
    expect(await readFile(env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("quarantined failure, not a product pass");
  });
}

test("outside the explicit CI switch, original matching failures still throw and retain diagnostics", async () => {
  const original = failure("firefox");
  const env = await evidence();
  await expect(handleStorageFailure("firefox", original, { ...env, CI: undefined })).rejects.toBe(original);
  await expect(handleStorageFailure("firefox", original, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined })).rejects.toBe(original);
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-firefox-preservation.json"), "utf8"));
  expect(saved.quarantine).toBeNull();
  expect(saved.error).toBe(original.report.error);
});

test("missing evidence destinations, failed writes, and summary failures remain blocking", async () => {
  const original = failure("webkit");
  const env = await evidence();
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: undefined })).rejects.toBe(original);
  await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: undefined })).rejects.toBe(original);
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "file");
  await writeFile(blocked, "not a directory");
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toThrow();
  await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: join(blocked, "summary.md") })).rejects.toThrow();
});

test("ordinary assertions and cleanup or receipt errors never enter quarantine", async () => {
  const env = await evidence();
  for (const message of ["receipt mismatch", "cleanup failed", "unsupported user symlink was destroyed", "active workspace was evicted"]) {
    const error = new Error(message);
    await expect(handleStorageFailure("firefox", error, env)).rejects.toBe(error);
  }
  const error = failure("webkit", { checkpoint: "preservation" });
  await expect(handleStorageFailure("webkit", error, env)).rejects.toBe(error);
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json"), "utf8"));
  expect(saved).toEqual({ browser: "webkit", quarantine: null, ...error.report });
});
