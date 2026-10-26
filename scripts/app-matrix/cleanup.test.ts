import { expect, test } from "bun:test";
import { serverCommand } from "./browser.mjs";

const pending = () => new Promise<never>(() => {});

function fixture(stop: () => Promise<unknown>, productError = new Error("page.goto: Timeout 90000ms exceeded")) {
  const releases: string[] = [];
  const preview = {
    on() {},
    exposeBinding: async () => ({ dispose: async () => { releases.push("binding"); } }),
    addInitScript: async () => ({ dispose: async () => { releases.push("script"); } }),
    evaluate: async () => {},
    goto: async (_url: string, options: { timeout: number }) => { expect(options.timeout).toBe(90_000); throw productError; },
    close: async () => { releases.push("preview"); },
  };
  const page = {
    evaluate: async (fn: () => unknown, text?: string) => {
      if (text) return;
      const source = String(fn);
      if (source.includes("shell.input")) return stop();
      if (source.includes("serving:")) return { done: false, serving: true };
      if (source.includes("previews.ready")) return "ready";
      if (source.includes("previews.url")) return "http://localhost/preview";
      return false;
    },
  };
  const input = {
    page, context: { newPage: async () => preview },
    command: { name: "dev", args: ["run", "dev"], check: { kind: "page", text: "matrix" } },
    app: { id: "next" }, engine: "browser", options: { timeout: 90_000, cleanupTimeout: 20, output: "/unused" },
    terminalText: async () => "user@bun:~$ bun run .matrix-command.ts dev\noriginal product output\n",
  };
  return { input, releases };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("serverCommand did not return after cleanup deadline")), 200);
    })]);
  } finally { clearTimeout(timer); }
}

test("stuck Ctrl-C does not swallow the original product timeout or prevent preview release", async () => {
  const { input, releases } = fixture(pending);
  const result = await within(serverCommand(input));
  expect(result.status).toBe("fail");
  expect("blocker" in result && result.blocker).toContain("page.goto: Timeout 90000ms exceeded");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([expect.objectContaining({ operation: "server-stop", timedOut: true })]);
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
  const { input, releases } = fixture(async () => {});
  const preview = await input.context.newPage();
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
  const { input } = fixture(async () => { throw new Error("Target page, context or browser has been closed"); }, new Error("page.goto: navigation interrupted"));
  const preview = await input.context.newPage();
  preview.close = pending;
  const result = await within(serverCommand(input));
  expect("productError" in result && result.productError).toBe("Error: page.goto: navigation interrupted");
  expect("harnessCleanup" in result && result.harnessCleanup).toEqual([
    expect.objectContaining({ operation: "server-stop", timedOut: false, error: "Error: Target page, context or browser has been closed" }),
    expect.objectContaining({ operation: "preview-close", timedOut: true }),
  ]);
});
