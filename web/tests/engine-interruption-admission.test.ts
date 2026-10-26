import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserBuildConfig, resolveRuntimePackage } from "../../scripts/browser-build";
import { prepareLinkPlan } from "waffle/link";
import { prepareQuickjsProgram, programLinkPlan } from "../../src/assets";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";
import type { RunRequest } from "../src/bun-executor";

const source = await readFile(new URL("./engine-interruption-worker.ts", import.meta.url), "utf8");
const begin = source.indexOf("export function observesInstance(");
const end = source.indexOf("\ninstallAtomicsObservers();", begin);
expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end));
const { observesInstance }: { observesInstance(module: WebAssembly.Module, request: Pick<RunRequest, "module" | "linkPlan">, core: WebAssembly.Module | undefined): boolean } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

// The predicate runs without importing the worker's global Atomics observers into this test realm.
test("actual repeated Waffle preparation admits exactly the local linked core", async () => {
  const { core, side } = quickjsPair();
  const entry = await prepareQuickjsProgram(core, side);
  const linkPlan = programLinkPlan(entry);
  if (!linkPlan) throw new Error("fixture pair did not prepare a plan");
  const first = await prepareLinkPlan(structuredClone(linkPlan));
  const second = await prepareLinkPlan(structuredClone(linkPlan));
  expect(first.entryModule).not.toBeUndefined();
  expect(second.entryModule).toBe(first.entryModule);
  const request = { module: structuredClone(entry), linkPlan };
  expect(request.module).not.toBe(entry);
  expect(observesInstance(second.entryModule, request, first.entryModule)).toBe(true);
  expect(observesInstance(new WebAssembly.Module(side), request, first.entryModule)).toBe(false);
  expect(observesInstance(new WebAssembly.Module(core), request, first.entryModule)).toBe(false);
  expect(observesInstance(structuredClone(entry), request, first.entryModule)).toBe(false);
  expect(observesInstance(request.module, request, first.entryModule)).toBe(false);
  expect(observesInstance(first.entryModule, { ...request, linkPlan: { ...linkPlan, reserve: "wrong" } }, first.entryModule)).toBe(false);
  const unrelated = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  expect(observesInstance(unrelated, request, unrelated)).toBe(false);
  expect(observesInstance(first.entryModule, { ...request, linkPlan: { ...linkPlan, core: { ...linkPlan.core, id: "side" } } }, first.entryModule)).toBe(false);
});

test("ordinary and Preview1 requests retain exact event-module identity", () => {
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  expect(observesInstance(module, { module }, undefined)).toBe(true);
  expect(observesInstance(structuredClone(module), { module }, undefined)).toBe(false);
  expect(observesInstance(structuredClone(module), { module }, structuredClone(module))).toBe(false);
});

const bundledControl = `
import { prepareQuickjsProgram, programLinkPlan } from ${JSON.stringify(new URL("../../src/assets.ts", import.meta.url).pathname)};
import { quickjsPair } from ${JSON.stringify(new URL("../../tests/package/quickjs-plan-fixture.ts", import.meta.url).pathname)};
import { Wasi } from "waffle/core";
import { createFilesystemConnection, FilesystemClient } from "waffle/fs";
${javascript}
export async function control() {
  const { prepareLinkPlan } = await import("waffle/link");
  const { core, side } = quickjsPair();
  const pageModule = await prepareQuickjsProgram(core, side);
  const linkPlan = programLinkPlan(pageModule);
  const first = await prepareLinkPlan(structuredClone(linkPlan));
  const second = await prepareLinkPlan(structuredClone(linkPlan));
  const request = { module: structuredClone(pageModule), linkPlan };
  const { linkedWorkerHooks } = await import("waffle/link");
  const hooks = linkedWorkerHooks();
  const connection = createFilesystemConnection();
  const wasi = new Wasi({ args: [], env: {}, preopens: {}, fs: new FilesystemClient(connection.client), stdout() {}, stderr() {}, sleep() {} });
  const context = { request, wasi, checkActive() {}, bindMemory() {} };
  const original = WebAssembly.Instance;
  const instantiated = [];
  const admitted = [];
  try {
    WebAssembly.Instance = new Proxy(original, { construct(Target, args) {
      instantiated.push(args[0]);
      admitted.push(observesInstance(args[0], request, first.entryModule));
      return new Target(...args);
    } });
    const instance = await hooks.instantiate({ runtime_proc: { signal: () => 0 } }, context);
    hooks.initialize(context);
    const result = {
      same: first.entryModule === second.entryModule && first.entryModule === pageModule,
      actual: instantiated[0] === first.entryModule,
      admitted,
      value: instance.exports.value(), ctors: instance.exports.ctors.value,
      rejected: [new WebAssembly.Module(core), structuredClone(first.entryModule), request.module, new WebAssembly.Module(side)]
        .map(module => observesInstance(module, request, first.entryModule)),
      sideAsCore: observesInstance(instantiated[1], request, instantiated[1]),
      ordinary: [observesInstance(pageModule, { module: pageModule }, undefined), observesInstance(request.module, { module: pageModule }, undefined)],
    };
    hooks.beforeFinish();
    result.released = instance.exports.__indirect_function_table.get(1) === null;
    return result;
  } finally { hooks.beforeFinish(); WebAssembly.Instance = original; connection.client.port.close(); connection.server.port.close(); }
}
`;

test("real browser bundling shares the exact cached core with dynamically imported worker hooks", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-admission-bundle-"));
  try {
    const consumer = new URL("./engine-interruption-worker.ts", import.meta.url).pathname;
    const installed = resolveRuntimePackage(consumer);
    const entry = join(scratch, "control.ts");
    await writeFile(entry, bundledControl);
    const config = browserBuildConfig([consumer], join(scratch, "dist"));
    const result = await Bun.build({ ...config, entrypoints: [entry] });
    expect(result.logs).toEqual([]);
    expect(result.success).toBe(true);
    const plans = Object.keys(result.metafile!.inputs).filter(path => installed.relativeInput(path) === "link/plan.ts");
    expect(plans).toHaveLength(1);
    const output = result.outputs.find(output => output.kind === "entry-point");
    if (!output) throw new Error("bundle entry missing");
    const { control } = await import(output.path);
    expect(await control()).toEqual({ same: true, actual: true, admitted: [true, false], value: 42, ctors: 1,
      rejected: [false, false, false, false], sideAsCore: false, ordinary: [true, false], released: true });
    const worker = await Bun.build(config);
    expect(worker.logs).toEqual([]);
    expect(worker.success).toBe(true);
    expect(Object.keys(worker.metafile!.inputs).filter(path => installed.relativeInput(path) === "link/plan.ts")).toHaveLength(1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Waffle stays dynamically imported after the Atomics observers are installed", () => {
  expect(source).not.toMatch(/^import\s+\{[^\n]+from "waffle\/link"/m);
  expect(source.indexOf('await import("waffle/link")')).toBeGreaterThan(source.indexOf("installAtomicsObservers();"));
});
