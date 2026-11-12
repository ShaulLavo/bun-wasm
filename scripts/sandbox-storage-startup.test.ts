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

test("storage Retry joins the engine download still running after index failure", async () => {
  type Engine = Awaited<ReturnType<Awaited<ReturnType<typeof models>>["boundary"]["loadWasm"]>>;
  const download = deferred<Engine>();
  const page = await models(undefined, sources, () => download.promise);
  let opens = 0;
  page.boundary.openStorage = async () => { if (++opens === 1) throw new Error("index opening failed"); };
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    sandbox.start();
    await turn();
    expect(sandbox.failure).toBe("storage");
    expect(page.loads).toHaveLength(1);
    sandbox.restart();
    await turn();
    expect(page.loads).toHaveLength(1);
    method<() => void>(sandbox, "terminalOpened")();
    download.resolve({ module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), size: 8, build: null });
    await turn();
    expect(page.runs[0]?.args).toEqual(["install"]);
    page.runs[0]!.done.resolve({ code: 0 });
    await turn();
    expect(page.runs[1]?.args).toEqual(["run", "dev"]);
    expect(sandbox.status.kind).not.toBe("error");
  } finally { download.reject(new Error("test cleanup")); await page.cleanup(); }
});

test("Retry reloads only a failed filesystem before any editor document exists", async () => {
  const page = await models(undefined, sources);
  const error = new Error("QuotaExceededError: filesystem startup failed");
  page.fixture.fs.mkdirp = async () => { throw error; };
  Object.assign(page.fixture.fs, { state: { status: "failed", error } });
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    sandbox.start();
    await turn();
    method<() => void>(sandbox, "terminalOpened")();
    await turn();
    expect(sandbox.failure).toBe("storage");
    expect(sandbox.editor?.path).toBe("");
    expect(sandbox.status.text).toContain("Retry reloads this page");
    expect(page.storageEvents).toContain("recover");
    sandbox.restart();
    await turn();
    expect(page.boundary.location.reloads).toBe(1);
    expect(page.storageEvents.filter(event => event === "runtime")).toHaveLength(1);
  } finally { await page.cleanup(); }
});

test("terminal startup Retry keeps any editor text in the current page", async () => {
  const page = await models(undefined, sources);
  const error = new Error("QuotaExceededError: filesystem startup failed");
  page.fixture.fs.mkdirp = async () => { throw error; };
  Object.assign(page.fixture.fs, { state: { status: "failed", error } });
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    sandbox.start();
    await turn();
    method<() => void>(sandbox, "terminalOpened")();
    await turn();
    const editor = sandbox.editor!;
    editor.setText("keep this text even before the first document opens");
    sandbox.restart();
    await turn();
    expect(page.boundary.location.reloads).toBe(0);
    expect(sandbox.editor).toBe(editor);
    expect(editor.view.state.doc.toString()).toContain("keep this text");
    expect(page.storageEvents.filter(event => event === "runtime")).toHaveLength(1);
  } finally { sandbox.editor?.discard(); await page.cleanup(); }
});

test("an engine download that finished with an error can be retried", async () => {
  let attempts = 0;
  const page = await models(undefined, sources, async () => {
    if (++attempts === 1) throw new Error("temporary download failure");
    return { module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), size: 8, build: null };
  });
  const sandbox = new page.Sandbox("?mode=fast");
  try {
    await method<() => Promise<void>>(sandbox, "loadEngine")();
    await method<() => Promise<void>>(sandbox, "loadEngine")();
    expect(attempts).toBe(2);
    expect(page.loads).toHaveLength(2);
  } finally { await page.cleanup(); }
});
