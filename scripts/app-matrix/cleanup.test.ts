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
  expect(result.blocker).toContain("page.goto: Timeout 90000ms exceeded");
  expect(result.harnessCleanup).toEqual([expect.objectContaining({ operation: "server-stop", timedOut: true })]);
  expect(releases).toContain("preview");
});

for (const outcome of ["resolved", "rejected"] as const) {
  test(`${outcome} server cleanup preserves the product error`, async () => {
    const stop = async () => { if (outcome === "rejected") throw new Error("page already closed"); };
    const { input, releases } = fixture(stop, new Error("navigation cancelled"));
    const result = await within(serverCommand(input));
    expect(result.blocker).toContain("navigation cancelled");
    expect(Boolean(result.harnessCleanup?.length)).toBe(outcome === "rejected");
    expect(releases).toContain("preview");
  });
}

test("unresponsive terminal capture does not replace the original navigation error", async () => {
  const { input } = fixture(async () => {});
  input.terminalText = pending;
  const result = await within(serverCommand(input));
  expect(result.blocker).toContain("page.goto: Timeout 90000ms exceeded");
  expect(result.harnessCleanup).toEqual([expect.objectContaining({ operation: "terminal-capture", timedOut: true })]);
});
