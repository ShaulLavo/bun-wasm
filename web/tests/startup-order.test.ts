import { afterEach, expect, test } from "bun:test";
import { deferred, filesystemFixture, method, models, turn } from "./ui-model-helpers";
import { InputGate } from "../src/playground/playground";
import { ENGINE_BIN } from "../../src/executable-paths";
import { PACKAGE_CONTINUATION } from "../../src/package-continuation-binding.ts";

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

test("a quota failure installing base programs recovers storage and installs again", async () => {
  const page = await models(undefined, { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "index.ts": "example" });
  cleanups.push(page.cleanup);
  let attempts = 0;
  page.boundary.programsReady = async () => {
    if (++attempts === 1) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return { path: "/bin" };
  };
  // Persistent mode: storage recovery exists only with a stored workspace.
  const sandbox = new page.Sandbox("?mode=fast");
  sandbox.start();
  method<() => void>(sandbox, "terminalOpened")();
  await until(() => page.runs.length === 1);
  expect(page.storageEvents).toContain("recover");
  expect(attempts).toBe(2);
  expect(page.runs[0]?.args).toEqual(["install"]);
});

test("base programs install only after the stored workspace is restored and checkpointed", async () => {
  const fixture = filesystemFixture();
  fixture.control.holdWrites = true;
  const page = await models(fixture, { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "index.ts": "example" });
  cleanups.push(page.cleanup);
  page.boundary.programsReady = async () => {
    // Writing executable markers while restoreSource rewrites the workspace failed with EEXIST.
    page.storageEvents.push(`programs after ${fixture.control.checkpoints} checkpoints`);
    return { path: "/bin" };
  };
  const sandbox = new page.Sandbox("?mode=fast");
  sandbox.start();
  method<() => void>(sandbox, "terminalOpened")();
  await until(() => fixture.writes.length === 1);
  for (let turns = 0; turns < 20; turns++) await turn();
  expect(page.storageEvents.some(event => event.startsWith("programs"))).toBe(false);
  releaseWrites(fixture);
  await until(() => page.runs.length === 1);
  const programs = page.storageEvents.findIndex(event => event.startsWith("programs"));
  expect(programs).toBeGreaterThan(page.storageEvents.indexOf("initialized"));
  // One checkpoint seeds the template; the pre-install checkpoint precedes the markers.
  expect(page.storageEvents[programs]).toBe(`programs after ${fixture.control.checkpoints} checkpoints`);
});

test("a shell that fails while the engine downloads ends startup without an unhandled rejection", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(undefined, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  try {
    Object.assign(page.boundary.BrowserSession, { create: async () => { throw new Error("shell worker failed"); } });
    const playground = new page.Playground("");
    method<() => void>(playground, "terminalOpened")();
    await playground.start();
    expect(playground.failure).toBe("startup");
    expect(playground.status.text).toContain("shell worker failed");
    await turn();
  } finally {
    engine.resolve(engineModule());
    await turn();
    process.off("unhandledRejection", record);
  }
  expect(unhandled).toEqual([]);
});

test("input typed during startup is dropped when another tab takes the workspace", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(undefined, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const delivered: string[] = [];
  let disposed = 0;
  const create = page.boundary.BrowserSession.create;
  Object.assign(page.boundary.BrowserSession, {
    create: async (options: Parameters<typeof create>[0]) => ({ ...await create(options), input: (data: string) => { delivered.push(data); }, dispose: async () => { disposed++; } }),
  });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => page.sessionCreates.length === 1);
  const listeners = (playground.term as unknown as { dataListeners: ((data: string) => void)[] }).dataListeners;
  for (const listener of listeners) listener("bun run index.ts\r");
  page.fixture.fs.ownershipLost = true;
  page.fixture.fs.onOwnershipLost?.();
  // Disposed while the engine is still downloading, not when Bun registration settles.
  await until(() => disposed === 1);
  engine.resolve(engineModule());
  await started;
  expect(delivered).toEqual([]);
  expect(playground.ready).toBe(false);
  expect(disposed).toBe(1);
});

test("a shell that finishes starting after a takeover is disposed without waiting for the engine", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(undefined, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const starting = deferred<void>();
  let disposed = 0;
  const create = page.boundary.BrowserSession.create;
  Object.assign(page.boundary.BrowserSession, {
    create: async (options: Parameters<typeof create>[0]) => {
      const shell = await create(options);
      await starting.promise;
      return { ...shell, dispose: async () => { disposed++; } };
    },
  });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => page.sessionCreates.length === 1);
  page.fixture.fs.ownershipLost = true;
  page.fixture.fs.onOwnershipLost?.();
  starting.resolve();
  await until(() => disposed === 1);
  engine.resolve(engineModule());
  await started;
  expect(disposed).toBe(1);
  expect(playground.failure).toBe("ownership");
});

test("after the shell fails, late download progress and the engine change nothing", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  let progress: ((text: string) => void) | undefined;
  const page = await models(undefined, undefined, report => { progress = report; return engine.promise; });
  cleanups.push(page.cleanup);
  Object.assign(page.boundary.BrowserSession, { create: async () => { throw new Error("shell worker failed"); } });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  progress?.("downloading bun.wasm… 1.0 MB");
  expect(playground.status).toEqual({ text: "Error: shell worker failed", kind: "error" });
  engine.resolve(engineModule());
  for (let turns = 0; turns < 20; turns++) await turn();
  expect(page.fixture.files.has(PACKAGE_CONTINUATION)).toBe(false);
  expect(playground.status.kind).toBe("error");
});

test("a shell that fails while the engine downloads fails startup, and nothing later replaces it", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  let progress: ((text: string) => void) | undefined;
  const page = await models(undefined, undefined, report => { progress = report; return engine.promise; });
  cleanups.push(page.cleanup);
  let disposed = 0;
  const create = page.boundary.BrowserSession.create;
  Object.assign(page.boundary.BrowserSession, {
    create: async (options: Parameters<typeof create>[0] & { onState(state: string, detail?: string): void }) => {
      const shell = await create(options);
      setTimeout(() => options.onState("failed", "shell worker crashed"), 0);
      return { ...shell, dispose: async () => { disposed++; } };
    },
  });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  expect(playground.failure).toBe("startup");
  expect(playground.status).toEqual({ text: "Error: shell worker crashed", kind: "error" });
  expect(disposed).toBe(1);
  progress?.("downloading bun.wasm… 1.0 MB");
  engine.resolve(engineModule());
  for (let turns = 0; turns < 20; turns++) await turn();
  expect(playground.status).toEqual({ text: "Error: shell worker crashed", kind: "error" });
  expect(playground.ready).toBe(false);
  expect(page.fixture.files.has(PACKAGE_CONTINUATION)).toBe(false);
});

/**
 * A playground started with a held engine. It counts live program registrations and exposes
 * the shell's state callback, so a test can fail the shell at a chosen startup step.
 */
async function registrationStartup() {
  const fixture = filesystemFixture();
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(fixture, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const programs = { active: 0 };
  Object.assign(page.runtime, { registerProgram: () => { programs.active++; return () => { programs.active--; }; } });
  let reportState: ((state: string, detail?: string) => void) | undefined;
  const create = page.boundary.BrowserSession.create;
  Object.assign(page.boundary.BrowserSession, {
    create: async (options: Parameters<typeof create>[0] & { onState(state: string, detail?: string): void }) => {
      reportState = options.onState;
      return create(options);
    },
  });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => reportState !== undefined);
  return { fixture, engine, playground, started, programs, failShell: (detail: string) => reportState?.("failed", detail) };
}

test("a shell that fails during Bun registration leaves no registrations or markers behind", async () => {
  const { fixture, engine, playground, started, programs, failShell } = await registrationStartup();
  // Registration starts, then waits on its first executable marker write.
  fixture.control.holdWrites = true;
  engine.resolve(engineModule());
  await until(() => fixture.writes.length === 1);
  const registeredBeforeFailure = programs.active;
  failShell("shell worker crashed");
  releaseWrites(fixture);
  await started;
  expect(playground.failure).toBe("startup");
  const markers = () => Array.from(fixture.files.keys()).filter(path => path === PACKAGE_CONTINUATION
    || Object.values(ENGINE_BIN).some(bin => ["bun", "bunx", "node", "nodejs"].some(name => path === `${bin}/${name}`)));
  await until(() => programs.active === 0 && markers().length === 0);
  expect(registeredBeforeFailure).toBeGreaterThan(0);
});

test("abandoning startup during the final checkpoint removes Bun without waiting for it", async () => {
  const { fixture, engine, playground, started, programs, failShell } = await registrationStartup();
  // Seeding is done; the next checkpoint is the one after Bun's registration. Hold it.
  const checkpoint = deferred<void>();
  fixture.checkpoints.push(checkpoint);
  const before = fixture.control.checkpoints;
  engine.resolve(engineModule());
  await until(() => fixture.control.checkpoints > before && programs.active > 0);
  failShell("shell worker crashed");
  await until(() => programs.active === 0);
  checkpoint.resolve();
  await started;
  expect(playground.failure).toBe("startup");
  expect(programs.active).toBe(0);
});

test("input the shell rejects during replay is reported and startup still finishes", async () => {
  const engine = deferred<ReturnType<typeof engineModule>>();
  const page = await models(undefined, undefined, () => engine.promise);
  cleanups.push(page.cleanup);
  const delivered: string[] = [];
  const create = page.boundary.BrowserSession.create;
  Object.assign(page.boundary.BrowserSession, {
    create: async (options: Parameters<typeof create>[0]) => ({ ...await create(options), input: (data: string) => {
      if (data.length > 1000) throw new RangeError("input chunk is too large");
      delivered.push(data);
    } }),
  });
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  const started = playground.start();
  await until(() => page.sessionCreates.length === 1);
  const listeners = (playground.term as unknown as { dataListeners: ((data: string) => void)[] }).dataListeners;
  for (const listener of listeners) listener("x".repeat(2000));
  for (const listener of listeners) listener("ls\r");
  engine.resolve(engineModule());
  await started;
  expect(playground.ready).toBe(true);
  expect(delivered).toEqual(["ls\r"]);
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
