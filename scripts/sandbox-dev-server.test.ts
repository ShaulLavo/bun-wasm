import { expect, test } from "bun:test";
import { NetNamespace } from "waffle/browser/net/helper";
import { NetHelper } from "../web/src/net/helper";
import { createRing } from "../web/src/net/ring";
import type { RunResult } from "../web/src/runner";
import { deferred, method, models, turn } from "../web/tests/ui-model-helpers";

const sources = { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "src/App.tsx": "app" };

async function fixture() {
  const page = await models(undefined, sources);
  const sandbox = new page.Sandbox("");
  const helpers: { dispose(): void }[] = [];
  let output = "";
  const cleanup = async () => { for (const helper of helpers) helper.dispose(); await page.cleanup(); };
  try {
    sandbox.start();
    if (!sandbox.term) throw new Error("Sandbox did not create its terminal");
    sandbox.term.write = data => { output += data; };
    method<() => void>(sandbox, "terminalOpened")();
    await turn();
    const install = page.runs[0];
    if (!install) throw new Error(`Sandbox did not start installation: ${sandbox.status.text}; ${output}`);
    expect(install.args).toEqual(["install"]);
    const dev = async () => {
      install.done.resolve({ code: 0 });
      await turn();
      const run = page.runs.at(-1);
      if (!run || run === install) throw new Error("Sandbox did not start its dev script");
      expect(run.args).toEqual(["run", "dev"]);
      return run;
    };
    const listen = async (run: Awaited<ReturnType<typeof dev>>) => {
      const namespace = await NetNamespace.create();
      const helper = new NetHelper(createRing(), namespace, {
        listening: port => run.network?.listening?.(port, helper),
        stopped: port => run.network?.stopped?.(port, helper),
      });
      helpers.push({ dispose() { helper.dispose(); namespace.dispose(); } });
      helper.handle({ type: "listen", id: 1, host: "127.0.0.1", port: 5173 });
      await turn();
      return helper;
    };
    return { page, sandbox, install, dev, listen, output: () => output, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

test("a silent successful dev exit before listening is a visible startup error", async () => {
  const f = await fixture();
  try {
    const run = await f.dev();
    run.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).toBe("error");
    expect(f.sandbox.status.text).toContain("stopped before it was ready");
    expect(f.sandbox.status.text).toContain("Restart");
    expect(f.sandbox.serverState.state).toBe("down");
    expect(f.output()).toContain("stopped before it was ready");
    expect(f.output()).not.toContain("[dev exited with code 0]");
    const html = await f.page.renderSandbox(f.sandbox);
    expect(html).toContain('data-kind="error"');
    expect(html).toContain(f.sandbox.status.text);
    expect(f.sandbox.failure).toBeUndefined();
  } finally { await f.cleanup(); }
});

test("successful installation can finish without listening and proceed to dev", async () => {
  const f = await fixture();
  try {
    await f.dev();
    expect(f.sandbox.status.kind).not.toBe("error");
    expect(f.sandbox.serverState.state).toBe("starting");
    expect(f.output()).not.toContain("exited");
  } finally { await f.cleanup(); }
});

test("a listener opened during installation does not satisfy dev startup", async () => {
  const f = await fixture();
  try {
    const helper = await f.listen(f.install);
    helper.dispose();
    const run = await f.dev();
    run.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).toBe("error");
    expect(f.output()).toContain("stopped before it was ready");
  } finally { await f.cleanup(); }
});

test("a server using the installed network callbacks can close and exit successfully", async () => {
  const f = await fixture();
  try {
    const run = await f.dev();
    const helper = await f.listen(f.install);
    expect(f.sandbox.serverState.state).toBe("up");
    expect(f.sandbox.serverState.text).toBe("localhost:5173/");
    helper.dispose();
    expect(f.sandbox.serverState.state).toBe("down");
    run.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).not.toBe("error");
    expect(f.output()).toContain("[dev exited with code 0]");
    expect(f.output()).not.toContain("stopped before it was ready");
  } finally { await f.cleanup(); }
});

for (const result of [{ code: 1 }, { code: 70, error: "Worker failed to start" }, { code: 0, error: "Worker failed to start" }] satisfies RunResult[]) {
  test(`a failed dev exit ${result.code} preserves its diagnostic without another terminal error`, async () => {
    const f = await fixture();
    try {
      const run = await f.dev();
      run.hooks.stderr(new TextEncoder().encode("Cannot load vite.config.ts\n"));
      run.done.resolve(result);
      await turn();
      expect(f.sandbox.status.kind).toBe("error");
      expect(f.sandbox.status.text).toContain("Check the terminal output");
      expect(f.output().match(/Cannot load vite.config.ts/g)).toHaveLength(1);
      expect(f.output()).toContain(`[dev exited with code ${result.code}]`);
      expect(f.output()).not.toContain("stopped before it was ready");
      if ("error" in result) expect(f.output().match(/Worker failed to start/g)).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
}

test("listener history belongs to the dev run and resets on Restart", async () => {
  const f = await fixture();
  try {
    const old = await f.dev();
    const helper = await f.listen(old);
    helper.dispose();
    f.sandbox.restart();
    await turn();
    old.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).not.toBe("error");
    expect(f.output()).not.toContain("[dev exited");
    const install = f.page.runs.at(-1)!;
    expect(install.args).toEqual(["install"]);
    install.done.resolve({ code: 0 });
    await turn();
    const next = f.page.runs.at(-1)!;
    expect(next.args).toEqual(["run", "dev"]);
    next.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).toBe("error");
    expect(f.output()).toContain("stopped before it was ready");
  } finally { await f.cleanup(); }
});

test("installation failures keep their exit diagnostic without a dev startup error", async () => {
  const f = await fixture();
  try {
    f.install.done.resolve({ code: 1 });
    await turn();
    expect(f.page.runs).toHaveLength(1);
    expect(f.output()).toContain("[install exited with code 1]");
    expect(f.output()).not.toContain("stopped before it was ready");
  } finally { await f.cleanup(); }
});

// The page's workspace watch overflows while `bun install` extracts thousands of files. A
// reconcile then must not kill and rerun the install (it used to, silently, 2 of 8 cold Nuxt runs).
const restartReasons = ["fs-overflow", "recovered", "rebound"] as const;
type Reconcile = (reason: (typeof restartReasons)[number]) => Promise<void>;

test("a watch reconcile during installation leaves the install running", async () => {
  const f = await fixture();
  try {
    const reconcile = method<Reconcile>(f.sandbox, "handleWatchReconcile");
    for (const reason of restartReasons) await reconcile(reason);
    await turn();
    expect(f.install.kills).toEqual([]);
    expect(f.page.runs).toHaveLength(1);
    await f.dev();
  } finally { await f.cleanup(); }
});

test("a watch reconcile during installation waits across the install-to-dev handoff until dev listens", async () => {
  const f = await fixture();
  try {
    const fs = f.page.fixture.fs;
    const listFiles = fs.listFiles.bind(fs);
    let lists = 0;
    fs.listFiles = (root) => { lists++; return listFiles(root); };
    const reconcile = method<Reconcile>(f.sandbox, "handleWatchReconcile");
    for (const reason of restartReasons) await reconcile(reason);
    expect(lists).toBe(0);
    // Hold the post-install flush so we also check watch/changed activity during the handoff window.
    const flush = deferred<void>();
    f.page.fixture.checkpoints.push(flush);
    f.install.done.resolve({ code: 0 });
    await turn();
    expect(f.page.runs).toHaveLength(1);
    expect(lists).toBe(0);
    await reconcile("fs-overflow");
    method<() => void>(f.sandbox, "changed")();
    await turn();
    expect(lists).toBe(0);
    flush.resolve();
    await turn();
    const run = f.page.runs.at(-1)!;
    expect(run.args).toEqual(["run", "dev"]);
    expect(lists).toBe(0);
    await f.listen(run);
    expect(lists).toBe(1);
  } finally { await f.cleanup(); }
});

test("a watch reconcile during a serving dev server restarts it and says why the old one ended", async () => {
  const f = await fixture();
  try {
    const run = await f.dev();
    await f.listen(run);
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("rebound");
    expect(run.kills).toEqual([9]);
    run.done.resolve({ code: 137 });
    await turn();
    expect(f.output().match(/\[dev stopped: [^\]]*\]/g)).toEqual(["[dev stopped: restarting]"]);
    const install = f.page.runs.at(-1)!;
    expect(install).not.toBe(f.install);
    expect(install.args).toEqual(["install"]);
  } finally { await f.cleanup(); }
});

test("a dev script installs before it serves: a reconcile restarts it only once it listens", async () => {
  const f = await fixture();
  try {
    // `"dev": "bun install && bunx vite"` is still installing until it opens a listener.
    const run = await f.dev();
    const reconcile = method<Reconcile>(f.sandbox, "handleWatchReconcile");
    for (const reason of restartReasons) await reconcile(reason);
    expect(run.kills).toEqual([]);
    expect(f.page.runs.at(-1)).toBe(run);
    await f.listen(run);
    await reconcile("fs-overflow");
    expect(run.kills).toEqual([9]);
  } finally { await f.cleanup(); }
});

test("a reconcile that began during installation never restarts the dev run that follows", async () => {
  const f = await fixture();
  try {
    // Hold the reconcile inside its editor sync while the install exits and dev starts serving.
    const held = Object.keys(sources).map((path) => {
      const read = deferred<Uint8Array | undefined>();
      f.page.fixture.reads.set(`/home/user/app/${path}`, read);
      return read;
    });
    const reconcile = method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    const run = await f.dev();
    await f.listen(run);
    for (const read of held) read.resolve(new TextEncoder().encode("app"));
    f.page.fixture.reads.clear();
    await reconcile;
    await turn();
    expect(run.kills).toEqual([]);
    expect(f.page.runs.at(-1)).toBe(run);
  } finally { await f.cleanup(); }
});

test("an owner tab's watch reconcile restarts only its serving dev server, and only that run", async () => {
  const f = await fixture();
  try {
    const guards: (() => boolean)[] = [];
    Reflect.set(f.sandbox, "coordinator", {
      role: "owner",
      hasActiveResetIntent: () => false,
      broadcastOwnerState() {},
      restartOwnedDevServer: async (stillWanted: () => boolean) => { guards.push(stillWanted); return { ok: true }; },
    });
    const reconcile = method<Reconcile>(f.sandbox, "handleWatchReconcile");
    for (const reason of restartReasons) await reconcile(reason);
    expect(guards).toHaveLength(0);
    const run = await f.dev();
    await reconcile("fs-overflow");
    expect(guards).toHaveLength(0);
    await f.listen(run);
    await reconcile("fs-overflow");
    expect(guards).toHaveLength(1);
    expect(guards[0]!()).toBe(true);
    // Once that run ends, the queued restart it asked for is no longer wanted.
    method<(reason: string) => void>(f.sandbox, "stopDevServer")("restarting");
    expect(guards[0]!()).toBe(false);
  } finally {
    Reflect.set(f.sandbox, "coordinator", null);
    await f.cleanup();
  }
});

test("lockfile changes and the editor's fallback list the workspace only once dev listens", async () => {
  const f = await fixture();
  try {
    const fs = f.page.fixture.fs;
    const listFiles = fs.listFiles.bind(fs);
    let lists = 0;
    fs.listFiles = (root) => { lists++; return listFiles(root); };
    const editor = f.sandbox.editor!;
    const active = editor.path;
    expect(active).not.toBe("");
    // The open file disappears mid-install: the editor needs a listing to pick another one.
    f.page.fixture.files.delete(`/home/user/app/${active}`);
    method<(paths: readonly string[]) => void>(f.sandbox, "handleWatchedPaths")(["bun.lock", active]);
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    await Bun.sleep(250);
    expect(lists).toBe(0);
    expect(editor.path).toBe("");
    const run = await f.dev();
    await turn();
    expect(lists).toBe(0);
    expect(editor.path).toBe("");
    await f.listen(run);
    await turn();
    expect(lists).toBeGreaterThanOrEqual(1);
    expect(editor.path).not.toBe("");
    expect(editor.path).not.toBe(active);
  } finally { await f.cleanup(); }
});

function trackListings(f: Awaited<ReturnType<typeof fixture>>) {
  const fs = f.page.fixture.fs;
  const listFiles = fs.listFiles.bind(fs);
  let lists = 0;
  fs.listFiles = (root) => { lists++; return listFiles(root); };
  return { count: () => lists, reset: () => { lists = 0; } };
}

async function pauseAtPostInstallFlush(f: Awaited<ReturnType<typeof fixture>>) {
  await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
  const flush = deferred<void>();
  f.page.fixture.checkpoints.push(flush);
  f.install.done.resolve({ code: 0 });
  await turn();
  return flush;
}

test("a failed install, flush failure, or dev exit before listening runs deferred listing", async () => {
  // 1. Failed install runs deferred listing immediately.
  {
    const f = await fixture();
    try {
      const listings = trackListings(f);
      await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
      expect(listings.count()).toBe(0);
      f.install.done.resolve({ code: 1 });
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }

  // 2. Post-install fs.flush() failure runs deferred listing.
  {
    const f = await fixture();
    try {
      const listings = trackListings(f);
      const flush = await pauseAtPostInstallFlush(f);
      expect(listings.count()).toBe(0);
      flush.reject(new Error("flush refused"));
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }

  // 3. Dev exiting before listening runs deferred listing.
  {
    const f = await fixture();
    try {
      const listings = trackListings(f);
      await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
      const run = await f.dev();
      expect(listings.count()).toBe(0);
      run.done.resolve({ code: 1 });
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }

  // 4. Standalone command("install") without handoffToDev runs deferred listing on exit.
  {
    const f = await fixture();
    try {
      const run = await f.dev();
      await f.listen(run);
      run.done.resolve({ code: 0 });
      await turn();
      const listings = trackListings(f);
      const revision = Reflect.get(f.sandbox, "serverRevision") as number;
      const wasm = Reflect.get(f.sandbox, "wasm") as { module: WebAssembly.Module };
      const standalone = method<(...args: unknown[]) => Promise<RunResult | undefined>>(f.sandbox, "command")(
        "install",
        { engine: f.sandbox.engine, profile: f.sandbox.profile, module: wasm.module, env: {}, runtime: f.page.runtime, moduleScope: true, network: Reflect.get(f.sandbox, "network") },
        0,
        revision,
      );
      await turn();
      const standaloneRun = f.page.runs.at(-1)!;
      expect(standaloneRun.args).toEqual(["install"]);
      await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
      expect(listings.count()).toBe(0);
      standaloneRun.done.resolve({ code: 0 });
      await standalone;
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test("coordinated runDevServerLoop defers listing across install-to-dev handoff and flushes on failure", async () => {
  const f = await fixture();
  try {
    const devRun = await f.dev();
    await f.listen(devRun);
    devRun.done.resolve({ code: 0 });
    await turn();

    const listings = trackListings(f);
    const ws = Reflect.get(f.sandbox, "workspace");
    const runLoop = method<(revision: number, ws: unknown) => Promise<void>>(f.sandbox, "runDevServerLoop");
    const revision1 = Reflect.get(f.sandbox, "serverRevision") as number;
    const loop1 = runLoop(revision1, ws);
    await turn();
    const install1 = f.page.runs.at(-1)!;
    expect(install1.args).toEqual(["install"]);
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    expect(listings.count()).toBe(0);

    const flush1 = deferred<void>();
    f.page.fixture.checkpoints.push(flush1);
    install1.done.resolve({ code: 0 });
    await turn();
    expect(listings.count()).toBe(0);
    flush1.resolve();
    await turn();
    const dev1 = f.page.runs.at(-1)!;
    expect(dev1.args).toEqual(["run", "dev"]);
    expect(listings.count()).toBe(0);
    await f.listen(dev1);
    expect(listings.count()).toBe(1);
    dev1.done.resolve({ code: 0 });
    await loop1;

    // A flush failure during coordinated handoff still runs deferred listing.
    listings.reset();
    const revision2 = Reflect.get(f.sandbox, "serverRevision") as number;
    const loop2 = runLoop(revision2, ws);
    await turn();
    const install2 = f.page.runs.at(-1)!;
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    const flush2 = deferred<void>();
    f.page.fixture.checkpoints.push(flush2);
    install2.done.resolve({ code: 0 });
    await turn();
    expect(listings.count()).toBe(0);
    flush2.reject(new Error("coordinated flush failed"));
    await loop2;
    await turn();
    expect(listings.count()).toBe(1);
  } finally { await f.cleanup(); }
});

test("deferred listing survives a Reset template or stopDevServer during the post-install flush", async () => {
  // 1. Reset template aborts during post-install flush: deferred listing runs once reset clears its flags.
  {
    const f = await fixture();
    try {
      const listings = trackListings(f);
      const flush = await pauseAtPostInstallFlush(f);
      expect(listings.count()).toBe(0);

      const fetch = f.page.boundary.fetch;
      f.page.boundary.fetch = async () => { throw new Error("template download failed"); };
      const reset = f.sandbox.reset();
      flush.resolve();
      await reset;
      f.page.boundary.fetch = fetch;
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }

  // 2. Direct stopDevServer during post-install flush clears the handoff and runs deferred listing.
  {
    const f = await fixture();
    try {
      const listings = trackListings(f);
      const flush = await pauseAtPostInstallFlush(f);
      expect(listings.count()).toBe(0);
      method<(reason: string) => void>(f.sandbox, "stopDevServer")("cancelled");
      flush.resolve();
      await turn();
      expect(listings.count()).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test("folder toggle refreshFiles defers during post-install flush and runs once dev listens", async () => {
  const f = await fixture();
  try {
    const listings = trackListings(f);
    const flush = deferred<void>();
    f.page.fixture.checkpoints.push(flush);
    f.install.done.resolve({ code: 0 });
    await turn();

    f.page.fixture.files.set("/home/user/app/toggled.txt", "1");
    await f.sandbox.refreshFiles();
    expect(listings.count()).toBe(0);
    expect(f.sandbox.files).not.toContain("toggled.txt");

    flush.resolve();
    await turn();
    const devRun = f.page.runs.at(-1)!;
    expect(devRun.args).toEqual(["run", "dev"]);
    expect(listings.count()).toBe(0);

    await f.listen(devRun);
    await turn();
    expect(listings.count()).toBe(1);
    expect(f.sandbox.files).toContain("toggled.txt");

    f.page.fixture.files.set("/home/user/app/after.txt", "2");
    await f.sandbox.refreshFiles();
    expect(listings.count()).toBe(2);
    expect(f.sandbox.files).toContain("after.txt");
  } finally { await f.cleanup(); }
});

test("deferred listing retries after an aborted coordinated reset rejects enterResetGate", async () => {
  for (const rejectAfterResetClears of [false, true]) {
    const f = await fixture();
    try {
      let resetIntent = false;
      let holdNextGates = false;
      const heldGates: ReturnType<typeof deferred<{ resetGeneration: number; release: () => void }>>[] = [];
      let gateCalls = 0;
      const rejectHeld = () => {
        for (const gate of heldGates.splice(0)) gate.reject(new f.page.ResetInProgressError());
      };
      Reflect.set(f.sandbox, "coordinator", {
        role: "owner",
        hasActiveResetIntent: () => resetIntent,
        broadcastOwnerState() {},
        enterResetGate: async () => {
          if (!holdNextGates) return { resetGeneration: 1, release() {} };
          gateCalls++;
          if (gateCalls <= 2) {
            const gate = deferred<{ resetGeneration: number; release: () => void }>();
            heldGates.push(gate);
            return gate.promise;
          }
          return { resetGeneration: 1, release() {} };
        },
        resetWorkspace: async () => {
          resetIntent = true;
          if (!rejectAfterResetClears) rejectHeld();
          await turn();
          resetIntent = false;
        },
      });

      const listings = trackListings(f);
      const editor = f.sandbox.editor!;
      const active = editor.path;
      f.page.fixture.files.delete(`/home/user/app/${active}`);
      await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
      expect(editor.path).toBe("");
      f.page.fixture.files.set("/home/user/app/after-reset-abort.txt", "ok");

      const devRun = await f.dev();
      holdNextGates = true;
      await f.listen(devRun);
      expect(gateCalls).toBe(2);
      expect(listings.count()).toBe(0);

      await f.sandbox.reset();
      if (rejectAfterResetClears) rejectHeld();
      await turn();

      // One retry for refreshFiles and one for editor fallback — no duplicate third listing.
      expect(listings.count()).toBe(2);
      expect(f.sandbox.files).toContain("after-reset-abort.txt");
      expect(editor.path).not.toBe("");
      expect(editor.path).not.toBe(active);
    } finally {
      Reflect.set(f.sandbox, "coordinator", null);
      await f.cleanup();
    }
  }
});

test("deferred listing work survives a Reset template that stops the install and then aborts", async () => {
  const f = await fixture();
  try {
    const fs = f.page.fixture.fs;
    const listFiles = fs.listFiles.bind(fs);
    let lists = 0;
    fs.listFiles = (root) => { lists++; return listFiles(root); };
    const editor = f.sandbox.editor!;
    const active = editor.path;
    f.page.fixture.files.delete(`/home/user/app/${active}`);
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    expect(editor.path).toBe("");
    // The reset stops the install, which exits while the reset still blocks listing; then the
    // template download fails and the reset gives up.
    const fetch = f.page.boundary.fetch;
    f.page.boundary.fetch = async () => { throw new Error("template download failed"); };
    const reset = f.sandbox.reset();
    expect(f.install.kills).toEqual([9]);
    f.install.done.resolve({ code: 137 });
    await reset;
    f.page.boundary.fetch = fetch;
    await turn();
    expect(f.output().match(/\[install stopped: [^\]]*\]/g)).toEqual(["[install stopped: resetting the template]"]);
    // One listing for the file tree and one for the editor's fallback, once each.
    expect(lists).toBe(2);
    expect(editor.path).not.toBe("");
    expect(editor.path).not.toBe(active);
    method<() => void>(f.sandbox, "changed")();
    await turn();
    expect(lists).toBe(2);
  } finally { await f.cleanup(); }
});

test("a deferred file-tree refresh waits for the workspace a retirement reopens", async () => {
  const f = await fixture();
  try {
    await method<Reconcile>(f.sandbox, "handleWatchReconcile")("fs-overflow");
    // The install wrote this; the tree may show it only after a listing that ran on a usable workspace.
    f.page.fixture.files.set("/home/user/app/installed.txt", "x");
    // Hold disposal so the stopped install exits while the retirement has no workspace.
    const disposing = deferred<void>();
    const hold = deferred<void>();
    const runtime = f.page.runtime;
    runtime.dispose = async () => { disposing.resolve(); await hold.promise; };
    const retired = method<(options: { mode: "reopen"; stopReason: string; timeoutMs: number }) => Promise<unknown>>(f.sandbox, "retireRuntime")({
      mode: "reopen",
      stopReason: "restarting",
      timeoutMs: 5_000,
    });
    await Promise.race([disposing.promise, Bun.sleep(2_000)]);
    expect(Reflect.get(f.sandbox, "workspace")).toBeNull();
    f.install.done.resolve({ code: 137 });
    for (let i = 0; i < 5; i++) await turn();
    hold.resolve();
    await retired;
    for (let i = 0; i < 5; i++) await turn();
    expect(f.sandbox.files).toContain("installed.txt");
  } finally { await f.cleanup(); }
});

test("a retirement says the cause it was given, once", async () => {
  const f = await fixture();
  try {
    const retired = method<(options: { mode: "reopen"; stopReason: string; timeoutMs: number }) => Promise<unknown>>(f.sandbox, "retireRuntime")({
      mode: "reopen",
      stopReason: "resetting the template",
      timeoutMs: 1_000,
    });
    await turn();
    expect(f.install.kills).toEqual([9]);
    f.install.done.resolve({ code: 137 });
    await retired;
    await turn();
    expect(f.output().match(/\[install stopped: [^\]]*\]/g)).toEqual(["[install stopped: resetting the template]"]);
  } finally { await f.cleanup(); }
});

test("an install stopped by Restart says why it ended", async () => {
  const f = await fixture();
  try {
    f.sandbox.restart();
    await turn();
    expect(f.install.kills).toEqual([9]);
    f.install.done.resolve({ code: 137 });
    await turn();
    expect(f.output()).toContain("[install stopped: restarting]");
    expect(f.page.runs.at(-1)!.args).toEqual(["install"]);
    expect(f.page.runs).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("follower tab navigates to the owner's broadcast cross-origin hosted preview URL and handles cross-origin frame load", async () => {
  const page = await models(undefined, sources);
  const sandbox = new page.Sandbox("");
  try {
    // Simulate a HostedPreviews router on a follower tab that has no owner binding for port 5173.
    const previews = Reflect.get(sandbox, "previews") as { url: (port: number, path?: string) => string };
    previews.url = () => { throw new Error("No hosted preview binding on follower"); };

    const listeners = new Map<string, Array<(event: Event) => void>>();
    const frame = {
      src: "",
      get contentDocument(): Document | null {
        throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
      },
      addEventListener(type: string, fn: (event: Event) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type: string, fn: (event: Event) => void) {
        const list = listeners.get(type);
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      },
    } as unknown as HTMLIFrameElement;
    sandbox.attachPreview(frame);

    const hostedUrl = "https://tok123.preview.example.test/";
    method<(state: unknown) => void>(sandbox, "handleObservedOwnerState")({
      ownerId: "owner-1",
      attemptId: "attempt-1",
      generation: 1,
      engine: "browser",
      state: "up",
      text: "localhost:5173/",
      port: 5173,
      url: hostedUrl,
    });

    expect(sandbox.serverState.state).toBe("up");
    expect(sandbox.serverState.url).toBe(hostedUrl);
    expect(frame.src).toBe(hostedUrl);

    for (const fn of [...(listeners.get("load") ?? [])]) {
      fn({ isTrusted: true } as Event);
    }
    expect(sandbox.status.kind).toBe("ok");
    expect(sandbox.status.text).toContain("shared workspace live");
    expect((Reflect.get(sandbox, "preview") as { loaded: unknown } | null)?.loaded).toEqual({ document: null, url: hostedUrl });
  } finally {
    await page.cleanup();
  }
});

test("a second concurrent navigate cannot unlock the editor during teardown", async () => {
  const f = await fixture();
  try {
    const devRun = await f.dev();
    await f.sandbox.editor?.open("src/App.tsx");
    const assigned: string[] = [];
    f.page.boundary.location.assign = (next: URL | string) => { assigned.push(String(next)); };
    const teardownGate = Promise.withResolvers<void>();
    const origTeardown = f.sandbox.teardown.bind(f.sandbox);
    f.sandbox.teardown = async () => {
      await teardownGate.promise;
      devRun.done.resolve({ code: 0 });
      await origTeardown();
    };
    const first = f.sandbox.navigate("engine", "quickjs");
    await turn();
    expect(f.sandbox.navigating).toBe(true);
    expect(f.sandbox.editor?.view.state.readOnly).toBe(true);
    const html = await f.page.renderSandbox(f.sandbox);
    expect(html).toContain('id="engine"');
    expect(html).toContain("disabled");

    // A second navigation while the first is in teardown must be a no-op and never unlock the editor.
    await f.sandbox.navigate("template", "vanilla");
    expect(f.sandbox.navigating).toBe(true);
    expect(f.sandbox.editor?.view.state.readOnly).toBe(true);
    f.sandbox.editor?.setText("dropped edit");
    expect(f.sandbox.editor?.view.state.doc.toString()).toBe("app");

    teardownGate.resolve();
    await first;
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toContain("engine=quickjs");
  } finally {
    await f.cleanup();
  }
});

test("follower recovers serverState up on matching owner heartbeat even if serverState was transiently reset", async () => {
  const f = await fixture();
  try {
    const frame = {
      src: "",
      contentDocument: null,
      addEventListener() {},
      removeEventListener() {},
    };
    f.sandbox.attachPreview(frame as unknown as HTMLIFrameElement);
    const ownerState = {
      ownerId: "owner-tab",
      attemptId: "attempt-1",
      generation: 1,
      engine: "browser",
      state: "up" as const,
      text: "localhost:5173/",
      port: 5173,
      url: "https://preview.example.test/",
    };
    const handleObserved = method<(s: typeof ownerState) => void>(f.sandbox, "handleObservedOwnerState");
    handleObserved(ownerState);
    expect(f.sandbox.serverState.state).toBe("up");

    // Simulate a transient reset of serverState (e.g. boot() racing an early owner heartbeat).
    method<(state: "starting" | "up" | "down", text: string) => void>(f.sandbox, "setServerState")("starting", "loading…");
    expect(f.sandbox.serverState.state).toBe("starting");

    // A matching heartbeat with the same tupleKey must restore serverState to "up".
    handleObserved(ownerState);
    expect(f.sandbox.serverState.state).toBe("up");
    expect(f.sandbox.serverState.url).toBe("https://preview.example.test/");
  } finally {
    await f.cleanup();
  }
});
