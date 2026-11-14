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

test("all hosted React optimizer protocols match only WebKit's first React startup", () => {
  for (const record of webkitReactProtocols) {
    const original = reactFailure({}, record);
    expect(storageQuarantine("webkit", original)).toBe("webkit-first-react-optimizer-bounds");
    expect(storageQuarantine("chromium", original)).toBeUndefined();
    expect(storageQuarantine("firefox", original)).toBeUndefined();
    for (const checkpoint of ["setup", "preservation", "vanilla-config-restart", "first-vite-vue-startup"] as const) {
      expect(storageQuarantine("webkit", reactFailure({ checkpoint }, record))).toBeUndefined();
    }
  }
});

test.each(webkitReactProtocols)("React quarantine rejects added output at every position in either complete terminal, protocol %#", record => {
  const report = reactFailure({}, record).report;
  for (const [index, page] of report.pages.entries()) {
    if (typeof page === "string") throw new Error("Invalid fixture");
    for (let position = 0; position <= page.terminal.length; position++) {
      const terminal = page.terminal.slice(0, position) + "unknown output\n" + page.terminal.slice(position);
      const pages = report.pages.map((item, itemIndex) => itemIndex === index ? { ...page, terminal } : item);
      expect(storageQuarantine("webkit", reactFailure({ pages }, record))).toBeUndefined();
    }
  }
});

test.each(webkitReactProtocols)("React quarantine preserves every stack frame, dependency, optimizer message, and exit status, protocol %#", record => {
  const report = reactFailure({}, record).report;
  const page = report.pages[1];
  if (!page || typeof page === "string") throw new Error("Invalid fixture");
  const replacements = [
    ["host:130:17", "host:130:18"], ["host:15:27", "host:16:27"],
    ["guard (bun-wasm:host:11:9471)", "guard (bun-wasm:host:11:9472)"],
    ["pump (bun-wasm:host:11:8296)", "pump (bun-wasm:host:11:8297)"],
    [page.terminal.includes("host:9:91027") ? "host:9:91027" : "host:9:90764", "host:9:91028"],
    ["<anonymous>", "differentSource"],
    ["Out of bounds access", "Maximum call stack size exceeded"],
    ["RangeError:", "TypeError:"], ["[optimizer] bundling dependencies...", "[optimizer] dependencies bundled"],
    ["react@19.3.1", "react@19.3.2"], ["VITE v8.3.5", "VITE v8.3.6"],
    ["24 packages installed", "23 packages installed"], ["exited with code 1", "exited with code 2"],
    ["[dev exited with code 1]", "[dev exited with code 0]"],
  ] satisfies readonly (readonly [string, string])[];
  for (const [before, after] of replacements) {
    expect(page.terminal).toContain(before);
    expect(storageQuarantine("webkit", reactFailure({ pages: target(report, { terminal: page.terminal.replace(before, after) }) }, record))).toBeUndefined();
  }
  expect(storageQuarantine("webkit", reactFailure({ pages: target(report, { terminal: page.terminal.replace(/RangeError:[\s\S]*?\n\nBun/, "Bun") }) }, record))).toBeUndefined();
});

test.each(webkitReactProtocols)("React quarantine rejects missing controls, pending edits, preview content, unknown errors and later assertions, protocol %#", record => {
  const report = reactFailure({}, record).report;
  const [active, page] = report.pages;
  if (!active || !page || typeof active === "string" || typeof page === "string" || !page.runtime || !active.runtime) throw new Error("Invalid fixture");
  const variants: Partial<Report>[] = [
    { pages: [] }, { pages: ["closed", page] }, { pages: [active, "closed"] },
    { pages: [{ ...active, frames: [{ src: active.frames[0]!.src, body: "Hello from hono\nIncrement0" }] }, page] },
    { pages: [{ ...active, status: "stopped" }, page] },
    { pages: [{ ...active, runtime: { ...active.runtime, pending: true } }, page] },
    { pages: target(report, { runtime: { ...page.runtime, pending: true } }) },
    { pages: target(report, { runtime: { ...page.runtime, filesystem: { status: "failed", error: "CLOSED" } } }) },
    { pages: target(report, { runtime: { ...page.runtime, editorPath: "vite.config.ts" } }) },
    { pages: target(report, { frames: [{ src: page.frames[0]!.src, body: "Vite + React" }] }) },
    { pages: target(report, { frames: [] }) },
    { pages: target(report, { url: page.url.replace("engine=browser", "engine=quickjs") }) },
    { pages: target(report, { url: page.url.replace("127.0.0.1", "localhost") }) },
    { pages: target(report, { status: "unknown failure" }) },
    { errors: report.errors.concat("RangeError: Out of bounds access") },
    { error: "Error: Storage readiness deadline: vanilla" },
    { error: "AssertionError: active workspace was evicted" },
    { error: "Error: restored source HMR replaced the document" },
    { error: "Error: unsupported user symlink was destroyed" },
    { error: "Error: receipt mismatch" }, { error: "Error: cleanup failed" },
  ];
  for (const patch of variants) expect(storageQuarantine("webkit", reactFailure(patch, record))).toBeUndefined();
});

test.each(webkitReactProtocols)("React quarantine normalizes only elapsed times, optimizer clock, worker ID and loopback ports, protocol %#", record => {
  const report = reactFailure({}, record).report;
  const pages = report.pages.map(page => typeof page === "string" ? page : {
    ...page,
    terminal: page.terminal.replace(/\[\d+ms\]/g, "[98765ms]").replace(/ready in \d+ ms/g, "ready in 98765 ms")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:45678").replace(/\d{1,2}:\d{2}:\d{2} [AP]M/g, "11:59:59 PM").replace(/tid = \d+/g, "tid = 123"),
  });
  expect(storageQuarantine("webkit", reactFailure({ pages }, record))).toBe("webkit-first-react-optimizer-bounds");
});

test.each(webkitReactProtocols)("React quarantine retains raw diagnostics and requires CI, report and summary writes before acceptance, protocol %#", async record => {
  const env = await evidence();
  const original = reactFailure({}, record);
  const warnings = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleStorageFailure("webkit", original, env);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]?.[0]).toContain("::warning title=Storage quarantine::webkit-first-react-optimizer-bounds");
  }
  finally { warnings.mockRestore(); }
  const saved = JSON.parse(await readFile(join(env.BUN_WASM_BROWSER_REPORT_DIR!, "sandbox-storage-webkit-preservation.json"), "utf8"));
  expect(saved).toEqual({ browser: "webkit", quarantine: "webkit-first-react-optimizer-bounds", ...original.report });
  expect(await readFile(env.GITHUB_STEP_SUMMARY!, "utf8")).toContain("webkit-first-react-optimizer-bounds");
  const disabled: NodeJS.ProcessEnv[] = [
    { ...env, CI: undefined }, { ...env, BUN_WASM_STORAGE_CI_QUARANTINE: undefined },
    { ...env, BUN_WASM_BROWSER_REPORT_DIR: undefined }, { ...env, GITHUB_STEP_SUMMARY: undefined },
  ];
  for (const settings of disabled) await expect(handleStorageFailure("webkit", original, settings)).rejects.toBe(original);
  const blocked = join(env.BUN_WASM_BROWSER_REPORT_DIR!, "blocked");
  await writeFile(blocked, "not a directory");
  await expect(handleStorageFailure("webkit", original, { ...env, BUN_WASM_BROWSER_REPORT_DIR: blocked })).rejects.toThrow();
  await expect(handleStorageFailure("webkit", original, { ...env, GITHUB_STEP_SUMMARY: join(blocked, "summary.md") })).rejects.toThrow();
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
