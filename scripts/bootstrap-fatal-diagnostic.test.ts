import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { posix } from "node:path";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");
const bootstrap = read("bootstrap.js");
const start = bootstrap.indexOf("  // --- uncaught errors");
const end = bootstrap.indexOf("  // --- globals", start);
if (start < 0 || end < 0) throw new Error("Bootstrap fatal handlers missing");

type FatalRuntime = {
  printError(error: unknown): void;
  handleUncaught(error: unknown): boolean;
  handleRejection(error: unknown, promise: unknown): boolean;
};

function fixture() {
  const output: string[] = [];
  const order: string[] = [];
  const context = createContext({});
  const inspectFactory: (internal: object) => unknown = runInContext(read("inspect.js"), context);
  const native = {
    engine: "host", preparedSourceName: () => undefined,
    platformInfo: { version: "test", arch: "wasm32" },
    writeStderr(text: string) { output.push(text); order.push("stderr"); },
    tlsDispose() { order.push("tls-dispose"); },
    closeAllDirs() { order.push("close-dirs"); },
    exit(code: number) { order.push(`exit ${code}`); },
  };
  const inspector = inspectFactory({ native });
  const internal = {
    native, require: () => inspector, cancelIoWaiters() {}, traceExit() {},
  };
  const process: { env: Record<string, string>; exitCode: number | undefined; listenerCount(): number; emit(): void; _fatalException(): void } = {
    env: {}, exitCode: undefined, listenerCount: () => 0, emit: () => { order.push("exit-event"); }, _fatalException() {},
  };
  context.internal = internal;
  context.process = process;
  const runtime: FatalRuntime = runInContext(`(() => {
    const native = internal.native;
    ${bootstrap.slice(start, end)}
    return internal;
  })()`, context);
  return { context, runtime, output, order, process };
}

for (const method of ["handleUncaught", "handleRejection"] as const) {
  for (const members of ['[]', '[{ name: "BuildMessage", message: "bundle-startup-cause", level: "error" }]']) {
    test(`${method} retains an aggregate without Error members before process disposal: ${members}`, () => {
      const f = fixture();
      const error: AggregateError = runInContext(`new AggregateError(${members}, "bundle-startup-cause")`, f.context);
      error.stack = "start@/home/user/start.ts:7:3";
      expect(f.runtime[method](error, undefined)).toBe(false);
      const output = f.output.join("");
      expect(output).toContain("AggregateError: bundle-startup-cause");
      expect(output).toContain("at start (/home/user/start.ts:7:3)");
      expect(output.indexOf("bundle-startup-cause")).toBeLessThan(output.indexOf("Bun vtest"));
      // An unclaimed uncaught error ends the guest itself, after process disposal.
      expect(f.order).toEqual(["stderr", "stderr", "exit-event", "tls-dispose", "close-dirs"].concat(method === "handleUncaught" ? ["exit 1"] : []));
      expect(f.process.exitCode).toBe(method === "handleUncaught" ? 1 : undefined);
      expect(error.message).toBe("bundle-startup-cause");
      expect(error.stack).toBe("start@/home/user/start.ts:7:3");
    });
  }
}

test("an aggregate with Error members retains the existing child diagnostic", () => {
  const f = fixture();
  const error: AggregateError = runInContext('new AggregateError([new Error("original-child-cause")], "aggregate")', f.context);
  f.runtime.printError(error);
  expect(f.output.join("")).toContain("error: original-child-cause");
});

test("an actual Bun.build rejection retains the native build cause through fatal rendering", async () => {
  const f = fixture();
  f.context.URL = URL;
  const factory: (internal: object) => { build(config: object): Promise<unknown> } = runInContext(read("bun.js"), f.context);
  const bun = factory({
    native: { platformInfo: { version: "test", revision: "test" }, hostCaps: {}, isatty: () => false,
      build() { throw new Error("/home/user/entry.ts:7:3: original-build-cause"); } },
    web: { Blob, Response, TextDecoder },
    require: (name: string) => name === "path" ? posix : { bun: () => ({}) },
  });
  const error: unknown = await bun.build({ entrypoints: ["/home/user/entry.ts"] }).then(() => undefined, error => error);
  expect(f.runtime.handleRejection(error, undefined)).toBe(false);
  expect(f.output.join("")).toContain("/home/user/entry.ts:7:3: original-build-cause");
  expect(f.output.join("")).toContain("Bundle failed");
});
