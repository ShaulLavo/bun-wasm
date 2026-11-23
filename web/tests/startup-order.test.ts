import { afterEach, expect, test } from "bun:test";
import { deferred, filesystemFixture, method, models, turn } from "./ui-model-helpers";
import { InputGate } from "../src/playground/playground";
import { ENGINE_BIN } from "../../src/executable-paths";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  // A booted playground installs the page's compile observer from its own bundled module copy.
  Reflect.deleteProperty(globalThis, "__bunwasmCompileObserver");
});

const engineModule = () => ({ module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), size: 8, build: null });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await turn();
  expect(check()).toBe(true);
}

function releaseWrites(fixture: ReturnType<typeof filesystemFixture>): void {
  fixture.control.holdWrites = false;
  for (const write of fixture.writes.splice(0)) write.done.resolve();
}

test("the playground downloads its engine while the workspace is still seeding", async () => {
  const fixture = filesystemFixture();
  fixture.control.holdWrites = true;
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(fixture, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => page.loads.length === 1 && fixture.writes.length === 1);
  expect(page.loads).toEqual(["bun-browser.wasm"]);
  releaseWrites(fixture);
  engine.resolve(engineModule());
  await started;
  expect(playground.ready).toBe(true);
});

test("the playground shell starts during the engine download and Run waits for Bun", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(undefined, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => page.sessionCreates.length === 1);
  expect(page.sessionCreates[0]?.env?.PATH).toBe(`${ENGINE_BIN.browser}:/bin`);
  expect(playground.ready).toBe(false);
  expect(playground.canRun).toBe(false);
  await playground.run();
  engine.resolve(engineModule());
  await started;
  expect(playground.ready).toBe(true);
  expect(playground.canRun).toBe(true);
});

test("the playground disposes a started shell when the engine fails", async () => {
  const page = await models(undefined, undefined, () => Promise.reject(new Error("engine unavailable")));
  cleanups.push(page.cleanup);
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  expect(playground.failure).toBe("startup");
  expect(playground.status.text).toContain("engine unavailable");
});

test("the sandbox loads process services while its workspace is still seeding", async () => {
  const fixture = filesystemFixture();
  fixture.control.holdWrites = true;
  const page = await models(fixture, { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "index.ts": "example" });
  cleanups.push(page.cleanup);
  let processes = 0;
  page.runtime.processes = async () => { processes++; };
  const sandbox = new page.Sandbox("");
  sandbox.start();
  method<() => void>(sandbox, "terminalOpened")();
  await until(() => fixture.writes.length === 1);
  expect(processes).toBeGreaterThan(0);
  expect(page.runs).toHaveLength(0);
  releaseWrites(fixture);
  await until(() => page.runs.length === 1);
  expect(page.runs[0]?.args).toEqual(["install"]);
});

test("typed input waits for the gate and keeps its order", () => {
  const gate = new InputGate();
  const delivered: string[] = [];
  gate.write("b");
  gate.write("un\r");
  expect(delivered).toEqual([]);
  gate.open(data => delivered.push(data));
  gate.write("ls\r");
  expect(delivered).toEqual(["b", "un\r", "ls\r"]);
});
