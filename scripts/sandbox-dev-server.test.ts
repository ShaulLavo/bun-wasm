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
    expect(f.sandbox.status.text).toContain("before it started listening");
    expect(f.sandbox.status.text).toContain("Restart");
    expect(f.sandbox.serverState.state).toBe("down");
    expect(f.output()).toContain("before it started listening");
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

test("a server that listened can close and exit successfully", async () => {
  const f = await fixture();
  try {
    const run = await f.dev();
    const helper = await f.listen(run);
    expect(f.sandbox.serverState.state).toBe("up");
    expect(f.sandbox.serverState.text).toBe("localhost:5173/");
    helper.dispose();
    expect(f.sandbox.serverState.state).toBe("down");
    run.done.resolve({ code: 0 });
    await turn();
    expect(f.sandbox.status.kind).not.toBe("error");
    expect(f.output()).toContain("[dev exited with code 0]");
    expect(f.output()).not.toContain("before it started listening");
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
      expect(f.output()).not.toContain("before it started listening");
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
    expect(f.output()).toContain("before it started listening");
  } finally { await f.cleanup(); }
});

test("installation failures keep their exit diagnostic without a dev startup error", async () => {
  const f = await fixture();
  try {
    f.install.done.resolve({ code: 1 });
    await turn();
    expect(f.page.runs).toHaveLength(1);
    expect(f.output()).toContain("[install exited with code 1]");
    expect(f.output()).not.toContain("before it started listening");
  } finally { await f.cleanup(); }
});
