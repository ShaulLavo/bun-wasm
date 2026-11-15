import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoragePreservationFailure } from "../sandbox/tests/storage-browser";
import { handleStorageFailure, storageQuarantine } from "./storage-ci-quarantine";
import firefoxProtocol from "./fixtures/storage-ci/firefox.json";
import webkitProtocol from "./fixtures/storage-ci/webkit.json";
import webkitReactProtocols from "./fixtures/storage-ci/webkit-react.json";
import webkitRestorationProtocol from "./fixtures/storage-ci/webkit-restoration.json";
import { StorageLifetime } from "./storage-browser-evidence";
import { discoverChecks } from "./test-checks";
import { needsJsc, needsRust } from "./ci-changes";

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

test("original WebKit config restart protocol matches its explicit source checkpoint", () => {
  expect(storageQuarantine("webkit", failure("webkit"))).toBe("webkit-vanilla-config-restart");
});

test("former Firefox Vue CLOSED protocol never matches a quarantine", () => {
  const checkpoints: Report["checkpoint"][] = ["setup", "preservation", "vanilla-config-restart", "first-vite-vue-startup", "first-vite-react-startup", "first-vanilla-restoration"];
  for (const checkpoint of checkpoints) {
    const original = failure("firefox", { checkpoint });
    for (const browser of ["firefox", "webkit", "chromium", "unknown"]) expect(storageQuarantine(browser, original)).toBeUndefined();
  }
});

test.each(webkitReactProtocols)("former React optimizer protocol %# never matches a quarantine", record => {
  const checkpoints: Report["checkpoint"][] = ["setup", "preservation", "vanilla-config-restart", "first-vite-vue-startup", "first-vite-react-startup", "first-vanilla-restoration"];
  for (const checkpoint of checkpoints) {
    const original = reactFailure({ checkpoint }, record);
    for (const browser of ["webkit", "firefox", "chromium"]) expect(storageQuarantine(browser, original)).toBeUndefined();
  }
});

async function assertHandlerRejected(original: StoragePreservationFailure, env: NodeJS.ProcessEnv, browser = "webkit"): Promise<void> {
  const summary = "Existing job summary\n";
  await writeFile(env.GITHUB_STEP_SUMMARY!, summary);
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(handleStorageFailure(browser, original, env)).rejects.toBe(original);
    expect(warnings).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); }
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, `sandbox-storage-${browser}-preservation.json`), "utf8"));
  expect(saved).toEqual({ browser, quarantine: null, ...original.report });
  expect(await readFile(env.GITHUB_STEP_SUMMARY!, "utf8")).toBe(summary);
}

test("former Firefox Vue CLOSED protocol retains diagnostics and rethrows without acceptance, including enabled CI", async () => {
  const env = await evidence();
  const original = failure("firefox");
  await assertHandlerRejected(original, env, "firefox");
  await assertHandlerRejected(failure("firefox", { checkpoint: "preservation" }), env, "firefox");
  await assertHandlerRejected(original, { ...env, CI: undefined }, "firefox");
  await assertHandlerRejected(original, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined }, "firefox");
});

test("former Firefox Vue CLOSED failure still blocks with missing destinations or failed report writes", async () => {
  const original = failure("firefox");
  const env = await evidence();
  await expect(handleStorageFailure("firefox", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: undefined })).rejects.toBe(original);
  await expect(handleStorageFailure("firefox", original, { ...env, GITHUB_STEP_SUMMARY: undefined })).rejects.toBe(original);
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "blocked");
  await writeFile(blocked, "not a directory");
  await expect(handleStorageFailure("firefox", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toMatchObject({ code: "ENOTDIR" });
});

test.each(webkitReactProtocols)("former React optimizer protocol %# retains diagnostics and rethrows without acceptance, including enabled CI", async record => {
  const env = await evidence();
  const original = reactFailure({}, record);
  await assertHandlerRejected(original, env);
  await assertHandlerRejected(reactFailure({ checkpoint: "preservation" }, record), env);
  await assertHandlerRejected(original, { ...env, CI: undefined });
  await assertHandlerRejected(original, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined });
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

  test(`${browser}: terminal normalization accepts only the remaining WebKit protocol`, () => {
    const report = failure(browser).report;
    const pages = report.pages.map(page => typeof page === "string" ? page : {
      ...page,
      terminal: page.terminal.replace(/\[\d+ms\]/g, "[99999ms]").replace(/ready in \d+ ms/g, "ready in 99999 ms")
        .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:45678").replace(/worker-[a-z0-9]+\.js:\d+:\d+/g, "worker-newhash.js:999:888"),
    });
    expect(storageQuarantine(browser, failure(browser, { pages }))).toBe(browser === "firefox" ? undefined : "webkit-vanilla-config-restart");
  });
}

test("WebKit: matching failure retains the complete protocol and labels the quarantine", async () => {
  const browser = "webkit";
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

test("outside the explicit CI switch, original matching failures still throw and retain diagnostics", async () => {
  const original = failure("webkit");
  const env = await evidence();
  await expect(handleStorageFailure("webkit", original, { ...env, CI: undefined })).rejects.toBe(original);
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined })).rejects.toBe(original);
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json"), "utf8"));
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

function restorationFailure(patch: Partial<Report> = {}): StoragePreservationFailure {
  const { error, errors, pages } = structuredClone(webkitRestorationProtocol);
  return new StoragePreservationFailure({ error, errors, pages, checkpoint: "first-vanilla-restoration", ...patch }, new Error(error));
}

test("restoration fixture remains owned by the blocking storage producer and quality check", () => {
  const checks = discoverChecks();
  const fixture = "scripts/fixtures/storage-ci/webkit-restoration.json";
  expect(checks.find(check => check.path === "scripts/storage-ci-quarantine.test.ts")?.owner).toBe("quality");
  expect(checks.find(check => check.path === "scripts/sandbox-storage-browser.test.ts")?.inputs).toContain(fixture);
  expect(needsRust([fixture])).toBe(true);
  expect(needsJsc([fixture])).toBe(false);
});

test("first vanilla restoration retains the original protocol before summary and warning, and labels skipped checks", async () => {
  const env = await evidence();
  const original = restorationFailure();
  expect(webkitRestorationProtocol.checkpoint).toBe("preservation");
  expect(storageQuarantine("webkit", original)).toBe("webkit-first-vanilla-restoration");
  const report = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json");
  const warnings = spyOn(console, "error").mockImplementation(() => {
    expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ ...original.report, browser: "webkit", quarantine: "webkit-first-vanilla-restoration" });
    expect(readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("remaining preservation checks were skipped");
  });
  try {
    await handleStorageFailure("webkit", original, env);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]?.[0]).toContain("::warning title=Storage quarantine::webkit-first-vanilla-restoration");
  } finally { warnings.mockRestore(); }
});

test("first restoration handler rejects other browsers, every other checkpoint and generic readiness errors", async () => {
  const env = await evidence();
  for (const browser of ["chromium", "firefox", "unknown"]) await assertHandlerRejected(restorationFailure(), env, browser);
  const checkpoints: Report["checkpoint"][] = ["setup", "preservation", "vanilla-config-restart", "first-vite-react-startup", "first-vite-vue-startup"];
  for (const checkpoint of checkpoints) await assertHandlerRejected(restorationFailure({ checkpoint }), env);
  const errors = ["Error: Storage readiness exceeded its startup deadline", "TimeoutError: waitForFunction: Timeout 180000ms exceeded.",
    "Error: Storage readiness deadline: vite-react", "Error: restored source HMR replaced the document", "Error: unsupported user symlink was destroyed",
    "AssertionError: active workspace was evicted", "Error: receipt mismatch", "Error: cleanup failed", "Error: thread exhaustion"];
  for (const error of errors) await assertHandlerRejected(restorationFailure({ error }), env);
  await assertHandlerRejected(restorationFailure(), { ...env, CI: undefined });
  await assertHandlerRejected(restorationFailure(), { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined });
});

test("first restoration handler rejects any changed runtime, frame, status, counter or console state", async () => {
  const env = await evidence();
  const report = restorationFailure().report;
  const pages: PageDiagnostic[] = report.pages.map(page => {
    if (typeof page === "string") throw new Error("Invalid fixture");
    return page;
  });
  for (const [index, page] of pages.entries()) {
    if (!page.runtime || !page.frames[0]) throw new Error("Invalid fixture");
    const frame = page.frames[0];
    const variants: Partial<PageDiagnostic>[] = [
      { url: page.url.replace("engine=browser", "engine=quickjs") }, { url: page.url.replace("engine=browser", "engine=jsc") },
      { url: page.url.replace("template=", "template=wrong-") }, { url: page.url.replace("127.0.0.1", "localhost") },
      { url: page.url.replace("/sandbox/", "/other/") }, { status: "unknown failure" }, { storage: "snapshot failed" },
      { runtime: null }, { runtime: { ...page.runtime, pending: true } }, { runtime: { ...page.runtime, started: false } },
      { runtime: { ...page.runtime, editorPath: "vite.config.ts" } },
      { runtime: { ...page.runtime, filesystem: { status: "failed", error: "CLOSED" } } },
      { runtime: { ...page.runtime, filesystem: { status: "ready", error: "unknown failure" } } },
      { frames: [] }, { frames: page.frames.concat(frame) },
      { frames: [{ ...frame, src: frame.src.replace("517", "518") }] }, { frames: [{ ...frame, documentUrl: "about:blank" }] },
      { frames: [{ ...frame, documentUrl: undefined }] }, { frames: [{ ...frame, readyState: "loading" }] },
      { frames: [{ ...frame, acceptedDocument: !frame.acceptedDocument }] }, { frames: [{ ...frame, acceptedDocument: undefined }] },
      { frames: [{ ...frame, body: index === 0 ? "Hello from hono\nIncrement0" : "Hello from vanilla TypeScript" }] },
    ];
    for (const patch of variants) await assertHandlerRejected(restorationFailure({ pages: pages.map((item, position) => position === index ? { ...item, ...patch } : item) }), env);
  }
  const variants: Partial<Report>[] = [
    { pages: [] }, { pages: ["closed", pages[1]!] }, { pages: [pages[0]!, "evaluation failed"] },
    { errors: [] }, { errors: report.errors.slice(1) }, { errors: report.errors.concat(report.errors[1]!) },
    { errors: report.errors.toReversed() }, { errors: report.errors.concat("RangeError: Out of bounds access at bun-wasm:host:130:17") },
    { errors: report.errors.concat("FilesystemTransportError: CLOSED") }, { errors: report.errors.concat("worker panic: thread spawn failed") },
    { errors: report.errors.concat("unknown console error") },
  ];
  for (const patch of variants) await assertHandlerRejected(restorationFailure(patch), env);
});

test("first restoration rejects inserted terminal output at every offset in both original transcripts", async () => {
  const env = await evidence();
  const report = restorationFailure().report;
  for (const [index, page] of report.pages.entries()) {
    if (typeof page === "string") throw new Error("Invalid fixture");
    for (let position = 0; position <= page.terminal.length; position++) {
      const terminal = page.terminal.slice(0, position) + "unknown output\n" + page.terminal.slice(position);
      const pages = report.pages.map((item, itemIndex) => itemIndex === index ? { ...page, terminal } : item);
      expect(storageQuarantine("webkit", restorationFailure({ pages }))).toBeUndefined();
    }
    for (const output of ["RangeError: Out of bounds access\n at bun-wasm:host:130:17", "FilesystemTransportError: CLOSED", "worker (tid = 4) panic: thread spawn failed", "[dev exited with code 1]"]) {
      const pages = report.pages.map((item, itemIndex) => itemIndex === index ? { ...page, terminal: page.terminal + output } : item);
      await assertHandlerRejected(restorationFailure({ pages }), env);
    }
  }
});

test("first restoration uses existing limited terminal normalizers and rejects changed dependency versions", async () => {
  const env = await evidence();
  const report = restorationFailure().report;
  const pages = report.pages.map(page => typeof page === "string" ? page : { ...page,
    terminal: page.terminal.replace(/\[\d+ms\]/g, "[98765ms]").replace(/ready in \d+ ms/g, "ready in 98765 ms").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:45678").replace(/\n/g, "\n\n"),
  });
  expect(storageQuarantine("webkit", restorationFailure({ pages }))).toBe("webkit-first-vanilla-restoration");
  for (const [index, page] of report.pages.entries()) {
    if (typeof page === "string") throw new Error("Invalid fixture");
    const terminal = page.terminal.replace("hono@4.10.2", "hono@4.10.3").replace("vite@8.3.5", "vite@8.3.6");
    await assertHandlerRejected(restorationFailure({ pages: report.pages.map((item, position) => position === index ? { ...page, terminal } : item) }), env);
  }
});

test("first restoration requires successful diagnostic and summary writes before acceptance", async () => {
  const env = await evidence();
  const original = restorationFailure();
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "blocked");
  await writeFile(blocked, "not a directory");
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: undefined })).rejects.toBe(original);
    await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: undefined })).rejects.toBe(original);
    await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toThrow();
    await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: join(blocked, "summary.md") })).rejects.toThrow();
    expect(warnings).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); }
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json"), "utf8"));
  expect(saved).toEqual({ ...original.report, browser: "webkit", quarantine: "webkit-first-vanilla-restoration" });
});

test.each(["context.close", "session.cleanup", "progress.write"])("independent %s failure blocks even after first restoration handler acceptance", async phase => {
  const env = await evidence();
  const error = new Error(phase);
  const lifetime = new StorageLifetime(phase === "progress.write" ? () => { throw error; } : undefined);
  if (phase !== "progress.write") lifetime.own(phase, () => Promise.reject(error));
  lifetime.event("before-handler");
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(lifetime.run(() => handleStorageFailure("webkit", restorationFailure(), env))).rejects.toBeInstanceOf(AggregateError);
    expect(lifetime.failures).toContain(error);
  } finally { warnings.mockRestore(); await lifetime.cleanup(); }
});
