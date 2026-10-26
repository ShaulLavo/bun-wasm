import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as path from "node:path";

const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${readFileSync(
  new URL("../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);

function workerModule(env: Record<string, string> = {}, execArgv: string[] = []) {
  const preloads: string[] = [];
  const launches: { argv: string[]; env: Record<string, string> }[] = [];
  const stop = new Error("captured spawn");
  const process = { env: { ...env }, execArgv, execPath: "bun", cwd: () => "/", noDeprecation: false };
  let port: unknown;
  const modules = {
    process, path, events: EventEmitter, structured_clone: { structuredClone }, net: {},
    worker_codec: { create: () => ({ wait: () => null, prepare: () => ({ graph: {}, commit() {}, abort() {} }), decode: () => [null, [], port] }) },
    spawn: { spawn(argv: string[], options: { env: Record<string, string> }) { launches.push({ argv, env: options.env }); throw stop; } },
    worker_channel: { open: () => ({ send() {} }) },
  };
  const internal = {
    native: {}, realTimers: { setImmediate() {} }, messagePortRefs: 0, addIoWaiter() {}, workerNoWarnings: false,
    require(name: string) { if (!(name in modules)) throw new Error(name); return Reflect.get(modules, name); },
    builtin: () => ({ createRequire: () => (name: string) => preloads.push(name) }),
  };
  const context = { EventTarget, Event, MessageEvent, DOMException, URL, structuredClone };
  const implementation = runInNewContext(source, context)(internal);
  port = new implementation.MessageChannel().port1;
  function launch(options: object = {}, filename = "") {
    expect(() => new implementation.Worker(filename, { eval: true, ...options })).toThrow(stop);
    return launches[launches.length - 1]!;
  }
  return { process, preloads, launches, implementation, internal, context, launch };
}

const operandCases = [
  { execArgv: ["--require", "--conditions=not-a-condition"], conditions: [], preloads: ["--conditions=not-a-condition"] },
  { execArgv: ["--require", "--conditions"], conditions: [], preloads: ["--conditions"] },
  { execArgv: ["--conditions", "--require=unintended-module"], conditions: ["--conditions", "--require=unintended-module"], preloads: [] },
  { execArgv: ["--conditions", "--no-deprecation"], conditions: ["--conditions", "--no-deprecation"], preloads: [] },
  { execArgv: ["--conditions", "--no-warnings", "--conditions", "--expose-gc"], conditions: ["--conditions", "--no-warnings", "--conditions", "--expose-gc"], preloads: [] },
  { execArgv: ["--conditions=first", "-r", "preload", "--conditions", "second", "--require=last"], conditions: ["--conditions=first", "--conditions", "second"], preloads: ["preload", "last"] },
];
for (const { execArgv, conditions, preloads } of operandCases) {
  test(`worker launch and initialization agree on operands: ${execArgv.join(" ")}`, () => {
    const parent = workerModule();
    const launch = parent.launch({ execArgv, argv: ["--conditions=app-argument"] });
    expect(launch.argv).toEqual(["bun"].concat(conditions, ["-e", "", "--conditions=app-argument"]));
    expect(launch.argv.every(arg => typeof arg === "string")).toBe(true);
    const child = workerModule({ ...launch.env, BUNWASM_WORKER_CONTROL: '{"input":12,"output":15}' });
    child.implementation.initialize();
    child.implementation.initialize();
    expect(child.process.execArgv).toEqual(execArgv);
    expect(child.preloads).toEqual(preloads);
    expect(child.process.noDeprecation).toBe(false);
    expect(child.internal.workerNoWarnings).toBe(false);
    expect(Object.hasOwn(child.context, "gc")).toBe(false);
    expect(parent.process.execArgv).toEqual([]);
  });
}

test("file workers pass conditions before run and leave application operands after the file", () => {
  const parent = workerModule();
  const launch = parent.launch({ eval: false, execArgv: ["--conditions", "vitest"], argv: ["--conditions=app"] }, "./vitest-worker.js");
  expect(launch.argv).toEqual(["bun", "--conditions", "vitest", "run", "/vitest-worker.js", "--conditions=app"]);
  expect(JSON.parse(launch.env.BUNWASM_WORKER_INIT!).argv).toEqual(["bun", "/vitest-worker.js", "--conditions=app"]);
});

test("worker conditions inherit, explicitly replace and isolate parent and sibling execArgv", () => {
  const execArgv = ["--conditions=parent", "--conditions", "second"];
  const parent = workerModule({}, execArgv);
  const inherited = parent.launch();
  const empty = parent.launch({ execArgv: [] });
  const explicit = parent.launch({ execArgv: ["--conditions=child"] });
  expect(inherited.argv).toEqual(["bun"].concat(execArgv, ["-e", ""]));
  expect(empty.argv).toEqual(["bun", "-e", ""]);
  expect(explicit.argv).toEqual(["bun", "--conditions=child", "-e", ""]);
  expect(JSON.parse(inherited.env.BUNWASM_WORKER_INIT!).execArgv).toEqual(execArgv);
  expect(JSON.parse(empty.env.BUNWASM_WORKER_INIT!).execArgv).toEqual([]);
  expect(parent.process.execArgv).toEqual(execArgv);
});

test("worker bootstrap applies real flags and preloads in order without consuming condition operands twice", () => {
  const parent = workerModule();
  const execArgv = ["--require", "first", "--conditions=custom", "--no-deprecation", "--no-warnings", "--expose-gc", "--require=second"];
  const child = workerModule({ ...parent.launch({ execArgv }).env, BUNWASM_WORKER_CONTROL: '{"input":12,"output":15}' });
  child.implementation.initialize();
  expect(child.preloads).toEqual(["first", "second"]);
  expect(child.process.execArgv).toEqual(execArgv);
  expect(child.process.noDeprecation).toBe(true);
  expect(child.internal.workerNoWarnings).toBe(true);
  expect(Object.hasOwn(child.context, "gc")).toBe(true);
});

for (const execArgv of [["--inspect"], ["--conditions"], ["--require"], ["--conditions=valid", "--not-supported"]]) {
  test(`worker still rejects unsupported or incomplete execArgv: ${execArgv.join(" ")}`, () => {
    const parent = workerModule();
    expect(() => new parent.implementation.Worker("", { eval: true, execArgv })).toThrow(expect.objectContaining({ code: "ERR_WORKER_INVALID_EXEC_ARGV" }));
    expect(parent.launches).toEqual([]);
  });
}
