import { expect, test } from "bun:test";
import { NetNamespace } from "waffle/browser/net/helper";
import { NetHelper } from "../web/src/net/helper";
import { createRing } from "../web/src/net/ring";
import type { RunResult } from "../web/src/runner";
import { method, models, turn } from "../web/tests/ui-model-helpers";

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
