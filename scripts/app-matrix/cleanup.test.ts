import { afterEach, expect, test } from "bun:test";
import { browserHost, earlyServerExit, serverCommand } from "./browser.mjs";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript-api";
import { HarnessCleanupError } from "./cleanup";
import { failure } from "./classify";
import { exitProvenance } from "./exit-provenance";
import { completeObservations } from "./product-browser";
import { checkCommand, checkInstall } from "./checks.mjs";

const pending = () => new Promise<never>(() => {});
function readyProbe() {
  const session = { send: async (_method: string) => {} };
  return {
    context: () => ({ newCDPSession: async () => session }),
    goto: async () => ({ ok: () => true, status: () => 200 }),
    close: async () => {},
  };
}
const fixtureDirectories: string[] = [];
afterEach(() => { for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true }); fixtureDirectories.length = 0; });

test("cleanup errors distinguish an omitted cause from a thrown undefined", () => {
  const failure = { operation: "test", timedOut: false, error: "secondary failure" };
  const withoutCause = new HarnessCleanupError([failure]);
  const withUndefined = new HarnessCleanupError([failure], undefined);
  expect(Object.hasOwn(withoutCause, "cause")).toBe(false);
  expect(Object.hasOwn(withUndefined, "cause")).toBe(true);
  expect(withUndefined.message).toContain("Original failure: undefined");
});

function fixture(stop: () => Promise<unknown>, productError = new Error("page.goto: Timeout 90000ms exceeded"), exit = 130) {
  const releases: string[] = [];
  const output = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-cleanup-fixture-"));
  fixtureDirectories.push(output);
  const preview = {
    on() {},
    exposeBinding: async () => ({ dispose: async () => { releases.push("binding"); } }),
    addInitScript: async () => ({ dispose: async () => { releases.push("script"); } }),
    evaluate: async () => {},
    goto: async (_url: string, options: { timeout: number }) => { releases.push("application-navigation"); expect(options.timeout).toBeLessThanOrEqual(90_000); throw productError; },
    close: async () => { releases.push("preview"); },
  };
  const probe = { ...readyProbe(), close: async () => { releases.push("probe"); } };
  const pages = [preview, probe];
  const page = {
    click: async (selector: string) => { expect(selector).toBe(".xterm"); releases.push("focus"); },
    keyboard: { press: async (key: string) => { expect(key).toBe("Control+c"); expect(releases.at(-1)).toBe("focus"); releases.push("keyboard"); await stop(); } },
    waitForFunction: async (expression: string) => {
      expect(runInNewContext(expression, { playground: { shell: { running: false } }, document: { querySelector: () => null } })).toBe(true);
      releases.push("idle");
    },
    evaluate: async (fn: () => unknown, text?: string) => {
      if (text) return;
      const source = String(fn);
      if (source.includes("shell.input")) throw new Error("Direct shell input bypassed the keyboard");
      if (source.includes("__matrixCommand")) return exit;
      if (source.includes("serving:")) return { done: false, serving: true };
      if (source.includes("previews.ready")) return "ready";
      if (source.includes("previews.url")) return "http://localhost/preview";
      return false;
    },
  };
  const input = {
    page, context: { newPage: async () => pages.shift() },
    command: { name: "dev", args: ["run", "dev"], check: { kind: "page", text: "matrix" } },
    app: { id: "next" }, engine: "browser", options: { timeout: 90_000, cleanupTimeout: 20, output },
    terminalText: async () => "user@bun:~$ bun run .matrix-command.ts dev\noriginal product output\n",
  };
  return { input, releases, preview, probe };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("serverCommand did not return after cleanup deadline")), 200);
    })]);
  } finally { clearTimeout(timer); }
}

for (const stage of ["Page.stopLoading", "Runtime.getIsolateId"]) {
  test(`stalled ${stage} reports cleanup failure and reaches teardown without application navigation`, async () => {
    const { input, releases, probe } = fixture(async () => {});
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const session = { send: async (method: string) => { if (method === stage) await pending; } };
    probe.context = () => ({ newCDPSession: async () => session });
    try {
      const result = await within(serverCommand(input));
      expect(result.status).toBe("fail");
      expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "probe-navigation-settlement", timedOut: true })]);
      expect(releases).toContain("probe");
      expect(releases).toContain("keyboard");
      expect(releases).toContain("preview");
      expect(releases).not.toContain("application-navigation");
    } finally { release(); }
  });
}

test("stuck Ctrl-C does not swallow the original product timeout or prevent preview release", async () => {
  const { input, releases } = fixture(pending);
  const result = await within(serverCommand(input));
  expect(result.status).toBe("fail");
  expect("blocker" in result && result.blocker).toContain("page.goto: Timeout 90000ms exceeded");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "server-stop", timedOut: true })]);
  expect(releases).toContain("preview");
});

test("matrix stop focuses the terminal, presses Ctrl-C and awaits idle before releasing the preview", async () => {
  const { input, releases } = fixture(async () => {});
  const result = await within(serverCommand(input));
  expect("harnessCleanup" in result && result.harnessCleanup).toBeFalsy();
  expect(releases.filter(item => ["focus", "keyboard", "idle", "preview"].includes(item))).toEqual(["focus", "keyboard", "idle", "preview"]);
});

test("matrix stop rejects an unexpected exit status without hiding the product failure", async () => {
  const { input, releases } = fixture(async () => {}, new Error("page.goto: fixture failure"), 1);
  const result = await within(serverCommand(input));
  expect("blocker" in result && result.blocker).toContain("page.goto");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "server-stop", error: "Error: Keyboard Ctrl-C exited 1" })]);
  expect(releases).toContain("preview");
});

for (const outcome of ["resolved", "rejected"] as const) {
  test(`${outcome} server cleanup preserves the product error`, async () => {
    const stop = async () => { if (outcome === "rejected") throw new Error("page already closed"); };
    const { input, releases } = fixture(stop, new Error("navigation cancelled"));
    const result = await within(serverCommand(input));
    expect("blocker" in result && result.blocker).toContain("navigation cancelled");
    expect(Boolean("harnessCleanup" in result && Array.isArray(result.harnessCleanup) && result.harnessCleanup.length)).toBe(outcome === "rejected");
    expect(releases).toContain("preview");
  });
}

test("unresponsive terminal capture does not replace the original navigation error", async () => {
  const { input } = fixture(async () => {});
  input.terminalText = pending;
  const result = await within(serverCommand(input));
  expect("blocker" in result && result.blocker).toContain("page.goto: Timeout 90000ms exceeded");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "terminal-capture", timedOut: true })]);
});

test("traffic cleanup deadline still reaches preview close", async () => {
  const { input, releases, preview } = fixture(async () => {});
  preview.evaluate = pending;
  const result = await within(serverCommand(input));
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "traffic-close", timedOut: true })]);
  expect(releases).toContain("preview");
});

test("a cleanup failure after successful assertions is not a green stage", async () => {
  const { withCleanupFailures } = await import("./cleanup");
  const product = { status: "pass", observations: [{ stage: "render", status: "pass" }] };
  expect(withCleanupFailures(product, [{ operation: "server-stop", timedOut: true, error: "stuck" }])).toMatchObject({
    status: "fail", product, harnessCleanup: [{ operation: "server-stop", timedOut: true }],
  });
});

for (const operation of ["context", "browser"] as const) {
  test(`${operation} close deadline kills its owned process and preserves the primary failure`, async () => {
    const { spawn } = await import("node:child_process");
    const { closeOwnedBrowser, closeOwnedContext, HarnessCleanupError } = await import("./cleanup");
    const primary = new Error("original product failure");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const browser = {
      close: pending,
      kill: async () => { child.kill("SIGKILL"); await exit; },
      process: () => child,
    };
    try {
      const close = operation === "context" ? closeOwnedContext({ close: pending }, browser, 20, primary) : closeOwnedBrowser(browser, 20);
      const error = await close.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HarnessCleanupError);
      if (!(error instanceof HarnessCleanupError)) throw error;
      expect(error.failures[0]?.operation).toBe(`${operation}-close`);
      if (operation === "context") expect(error.cause).toBe(primary);
      expect(child.signalCode).toBe("SIGKILL");
    } finally { child.kill("SIGKILL"); await exit; }
  });
}

test("successful context release does not terminate the shared browser", async () => {
  const { closeOwnedContext } = await import("./cleanup");
  let closed = false;
  const browser = { close: pending, kill: async () => { throw new Error("must keep healthy browser"); }, process: () => { throw new Error("must keep healthy browser"); } };
  await closeOwnedContext({ close: async () => { closed = true; } }, browser, 20);
  expect(closed).toBe(true);
});

test("failed force kill is reported instead of claiming browser cleanup", async () => {
  const { closeOwnedBrowser, HarnessCleanupError } = await import("./cleanup");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const browser = { close: pending, kill: pending, process: () => child };
    const error = await closeOwnedBrowser(browser, 20).catch((error: unknown) => error);
    if (!(error instanceof HarnessCleanupError)) throw new Error("Expected cleanup failure");
    expect(error.failures.map(failure => failure.operation)).toEqual(["browser-close", "browser-kill", "browser-exit"]);
    expect(child.signalCode).toBeNull();
  } finally { child.kill("SIGKILL"); await exit; }
});

test("closed product page and stuck preview close retain separate diagnostics", async () => {
  const { input, preview } = fixture(async () => { throw new Error("Target page, context or browser has been closed"); }, new Error("page.goto: navigation interrupted"));
  preview.close = pending;
  const result = await within(serverCommand(input));
  expect("productError" in result && result.productError).toBe("Error: page.goto: navigation interrupted");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([
    expect.objectContaining({ operation: "server-stop", timedOut: false, error: "Error: Target page, context or browser has been closed" }),
    expect.objectContaining({ operation: "preview-close", timedOut: true }),
  ]);
});


function nativePageBoundary(close: "stalled" | "rejected", phase: "navigation" | "assertion") {
  const listeners = new Map<string, (value: { type(): string; text(): string }) => void>();
  let killed = false;
  const productError = Object.assign(new Error(`original ${phase} Timeout 90000ms exceeded`), { name: "TimeoutError" });
  const context = { close: async () => {
    if (close === "rejected") throw new Error("context disposal rejected");
    await new Promise(() => {});
  } };
  const page = {
    on: (event: string, callback: (value: { type(): string; text(): string }) => void) => { listeners.set(event, callback); },
    goto: async () => {
      listeners.get("console")?.({ type: () => "error", text: () => "retained browser diagnostic" });
      if (phase === "navigation") throw productError;
    },
    locator: () => ({ filter: () => ({ waitFor: async () => { throw productError; } }) }),
    context: () => context,
  };
  return {
    launchServer: async () => ({
      wsEndpoint: () => "fixture",
      close: async () => {},
      kill: async () => { killed = true; },
      process: () => ({ exitCode: killed ? 0 : null, signalCode: null }),
    }),
    connect: async () => ({ newPage: async () => page }),
  };
}

async function withNativePageHost(close: "stalled" | "rejected", phase: "navigation" | "assertion", check: (host: Awaited<ReturnType<typeof browserHost>>) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-matrix-checkpage-"));
  const previous = process.env.PLAYWRIGHT;
  let host: Awaited<ReturnType<typeof browserHost>> | undefined;
  try {
    const fixturePath = join(scratch, "playwright.ts");
    writeFileSync(fixturePath, `export const chromium = (${nativePageBoundary.toString()})(${JSON.stringify(close)}, ${JSON.stringify(phase)});`);
    process.env.PLAYWRIGHT = fixturePath;
    host = await browserHost({
      root: resolve(import.meta.dir, "../.."), options: { timeout: 90_000, cleanupTimeout: 20, output: scratch },
      launch: () => { throw new Error("Must not launch an app"); }, stop: () => { throw new Error("No app child exists"); },
    });
    await check(host);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT;
    else process.env.PLAYWRIGHT = previous;
    try { await host?.close(); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}

function nativeRunner(host: Pick<Awaited<ReturnType<typeof browserHost>>, "checkPage">) {
  const source = ts.createSourceFile("run.mjs", readFileSync(new URL("./run.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Set(["record", "recordProductObservations", "checkPage", "checkServer", "execute", "nativeApp"]);
  const code = source.statements.filter(ts.isFunctionDeclaration).filter(node => functions.has(node.name?.text ?? "")).map(node => node.getText(source)).join("\n");
  const rows: { stage: string }[] = [];
  const writes: string[] = [];
  let stopped = 0;
  let finish: () => void = () => {};
  const done = new Promise<void>(resolve => { finish = resolve; });
  const proc = { child: { exitCode: null, signalCode: null }, done };
  const context = createContext({
    browserSession: host, options: { timeout: 100, output: "/unused" }, mirror: { base: "http://unused" },
    failure, HarnessCleanupError, earlyServerExit, exitProvenance, completeObservations, checkCommand, checkInstall, join,
    AbortSignal, Date, Map, Promise, JSON, console: { log() {} }, memory: { take: () => 0 }, results: rows,
    writeFileSync: (_path: string, content: string) => { writes.push(content); },
    prepare: () => "/unused/project", capture: async () => ({ code: 0, output: "installed" }),
    guestCommand: () => ["unused"], launch: () => proc, stop: () => { stopped++; finish(); },
    freePort: async () => 3137, text: () => "retained native terminal output", rmSync() {},
    fetch: async () => ({ ok: true }), sleep: async () => {},
  });
  runInContext(code, context);
  const app = { id: "control", dependencies: {}, commands: [
    { name: "dev", args: ["run", "server.ts"], check: { kind: "page", selector: "body", text: "matrix", probes: [{ id: "unattempted" }] } },
    { name: "later", after: "dev", args: ["run", "later.ts"], check: { kind: "stdout", text: "must not run" } },
  ] };
  context.app = app;
  return { rows, writes, stopped: () => stopped, run: async (): Promise<unknown> => runInContext("nativeApp(app, 'browser').then(() => null, error => error)", context) };
}

for (const [close, phase] of [["stalled", "navigation"], ["rejected", "assertion"]] as const) {
  test(`native ${phase} failure survives ${close} context cleanup`, async () => {
    await withNativePageHost(close, phase, async host => {
      const result = await host.checkPage("http://fixture.invalid", { selector: "body", text: "matrix" }, "/unused");
      expect(result).toMatchObject({ status: "fail", timedOut: true, productError: `TimeoutError: original ${phase} Timeout 90000ms exceeded` });
      expect("blocker" in result && result.blocker).toContain(`original ${phase}`);
      expect(result).toMatchObject({ browserDiagnostics: { events: [{ kind: "console-error", text: "retained browser diagnostic" }] } });
      expect(result).toHaveProperty("harnessCleanup", [expect.objectContaining({ operation: "context-close", timedOut: close === "stalled" })]);
    });
  });

  test(`native runner records the attempted failure then aborts after ${close} context cleanup`, async () => {
    await withNativePageHost(close, phase, async host => {
      const runner = nativeRunner(host);
      const error = await runner.run();
      expect(error).toBeInstanceOf(HarnessCleanupError);
      expect(runner.rows.map(row => row.stage)).toEqual(["install", "dev"]);
      expect(runner.writes.at(-1)).toContain(`original ${phase}`);
      expect(runner.writes.at(-1)).toContain("harnessCleanup");
      expect(runner.stopped()).toBe(1);
    });
  });
}

test("outer native page and server catches rethrow cleanup exceptions without retrying", async () => {
  const original = new Error("original product failure");
  const cleanup = new HarnessCleanupError([{ operation: "context-close", timedOut: true, error: "deadline" }], original);
  let attempts = 0;
  const runner = nativeRunner({ checkPage: async () => { attempts++; throw cleanup; } });
  expect(await runner.run()).toBe(cleanup);
  expect(attempts).toBe(1);
  expect(runner.rows.map(row => row.stage)).toEqual(["install"]);
  expect(runner.stopped()).toBe(1);
});
