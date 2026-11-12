import { expect, test } from "bun:test";
import { deferred, method, models, turn } from "../web/tests/ui-model-helpers";

const sources = { "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }), "src/App.tsx": "app" };

test("persistent startup reclaims before runtime creation while engine loading proceeds", async () => {
  const page = await models(undefined, sources);
  const prepare = deferred<void>();
  page.boundary.prepareStorage = () => prepare.promise;
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    sandbox.start();
    await turn();
    expect(page.storageEvents).toEqual(["open", "prepare"]);
    expect(page.loads).toHaveLength(1);
    expect(sandbox.editor).toBeUndefined();
    prepare.resolve();
    await turn();
    expect(page.storageEvents).toEqual(["open", "prepare", "runtime"]);
    method<() => void>(sandbox, "terminalOpened")();
    await turn();
    expect(page.storageEvents).toContain("initialize");
    expect(page.runs[0]?.args).toEqual(["install"]);
  } finally { prepare.resolve(); await page.cleanup(); }
});

test("source index open failure keeps startup in place and Retry constructs no premature runtime", async () => {
  const page = await models(undefined, sources);
  let opens = 0;
  page.boundary.openStorage = async () => { if (++opens === 1) throw new Error("index opening failed"); };
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    sandbox.start();
    await turn();
    expect(sandbox.failure).toBe("storage");
    expect(sandbox.editor).toBeUndefined();
    expect(sandbox.status.text).toContain("workspace was kept");
    expect(await page.renderSandbox(sandbox)).toContain(">Retry</button>");
    sandbox.restart();
    await turn();
    expect(opens).toBe(2);
    expect(page.storageEvents.filter(event => event === "runtime")).toHaveLength(1);
    expect(page.boundary.location.reloads).toBe(0);
    method<() => void>(sandbox, "terminalOpened")();
  } finally { await page.cleanup(); }
});
