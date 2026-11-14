import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoragePreservationFailure } from "../sandbox/tests/storage-browser";
import { handleStorageFailure, storageQuarantine } from "./storage-ci-quarantine";
import firefoxProtocol from "./fixtures/storage-ci/firefox.json";
import webkitProtocol from "./fixtures/storage-ci/webkit.json";
import webkitReactProtocols from "./fixtures/storage-ci/webkit-react.json";

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

function reactFailure(patch: Partial<Report> = {}, record = webkitReactProtocols[0]): StoragePreservationFailure {
  if (!record) throw new Error("Missing React protocol");
  return new StoragePreservationFailure({ ...structuredClone(record.report), checkpoint: "first-vite-react-startup", ...patch }, new Error(record.report.error));
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

test.each(webkitReactProtocols)("former React optimizer protocol %# never matches a quarantine", record => {
  const checkpoints: Report["checkpoint"][] = ["setup", "preservation", "vanilla-config-restart", "first-vite-vue-startup", "first-vite-react-startup"];
  for (const checkpoint of checkpoints) {
    const original = reactFailure({ checkpoint }, record);
    for (const browser of ["webkit", "firefox", "chromium"]) expect(storageQuarantine(browser, original)).toBeUndefined();
  }
});

async function assertReactRejected(original: StoragePreservationFailure, env: NodeJS.ProcessEnv): Promise<void> {
  const summary = "Existing job summary\n";
  await writeFile(env.GITHUB_STEP_SUMMARY!, summary);
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(handleStorageFailure("webkit", original, env)).rejects.toBe(original);
    expect(warnings).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); }
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json"), "utf8"));
  expect(saved).toEqual({ browser: "webkit", quarantine: null, ...original.report });
  expect(await readFile(env.GITHUB_STEP_SUMMARY!, "utf8")).toBe(summary);
}

test.each(webkitReactProtocols)("former React optimizer protocol %# retains diagnostics and rethrows without acceptance, including enabled CI", async record => {
  const env = await evidence();
  const original = reactFailure({}, record);
  await assertReactRejected(original, env);
  await assertReactRejected(reactFailure({ checkpoint: "preservation" }, record), env);
  await assertReactRejected(original, { ...env, CI: undefined });
  await assertReactRejected(original, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined });
});

test("former React optimizer failure still blocks with missing destinations or failed report writes", async () => {
  const original = reactFailure();
  const env = await evidence();
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: undefined })).rejects.toBe(original);
  await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: undefined })).rejects.toBe(original);
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "blocked");
  await writeFile(blocked, "not a directory");
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toMatchObject({ code: "ENOTDIR" });
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

  test(`${browser}: unknown output inside either historical terminal remains blocking`, async () => {
    const report = failure(browser).report;
    const [active, page] = report.pages;
    if (!active || !page || typeof active === "string" || typeof page === "string") throw new Error("Invalid fixture");
    const command = browser === "firefox" ? 'error: script "dev" exited with code 254' : "$ bun install (Browser (native))";
    const position = page.terminal.lastIndexOf(command);
    const extra = "Error: Cannot find module '/home/user/app/node_modules/vite/dist/node/cli.js'\n";
    const transcripts = [
      target(report, { terminal: page.terminal.slice(0, position) + extra + page.terminal.slice(position) }),
      target(report, { terminal: `unexpected guest output\n${page.terminal}` }),
      [{ ...active, terminal: `${active.terminal}\n${extra}` }, page],
    ];
    const env = await evidence();
    for (const pages of transcripts) {
      const original = failure(browser, { pages });
      expect(storageQuarantine(browser, original)).toBeUndefined();
      await expect(handleStorageFailure(browser, original, env)).rejects.toBe(original);
      const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, `sandbox-storage-${browser}-preservation.json`), "utf8"));
      expect(saved).toEqual({ browser, quarantine: null, ...original.report });
    }
  });

  test(`${browser}: only timing and local stack address differences are normalized`, () => {
    const report = failure(browser).report;
    const pages = report.pages.map(page => typeof page === "string" ? page : {
      ...page,
      terminal: page.terminal.replace(/\[\d+ms\]/g, "[99999ms]").replace(/ready in \d+ ms/g, "ready in 99999 ms")
        .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:45678").replace(/worker-[a-z0-9]+\.js:\d+:\d+/g, "worker-newhash.js:999:888"),
    });
    expect(storageQuarantine(browser, failure(browser, { pages }))).toBe(browser === "firefox" ? "firefox-first-vue-closed" : "webkit-vanilla-config-restart");
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
