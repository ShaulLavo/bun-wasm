// Artifact-free editor durability gate: actual pages, editors and IndexedDB worker, no wasm build.
// bun web/tests/browser-editor.ts [chromium|firefox|webkit]
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit, type Page } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const engine = process.argv[2] ?? "chromium";
const browserType = engine === "chromium" ? chromium : engine === "firefox" ? firefox : engine === "webkit" ? webkit : undefined;
if (!browserType) throw new Error(`Unknown browser ${engine}`);
const assets = new Map<string, Blob>();
const languageAssets = new Set<string>();
const requests: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let browserLaunch: ReturnType<typeof chromium.launch> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await (browser ?? await browserLaunch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}
const timeout = setTimeout(() => {
  console.error("Editor browser gate exceeded 90 seconds");
  void cleanup().finally(() => process.exit(1));
}, 90_000);

async function filesystemInfoCheck(base: string, mode: "memory" | "fast" | null): Promise<void> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/playground/${mode ? `?mode=${mode}` : ""}`);
    await page.waitForFunction(() => !!window.playground);
    assert.deepEqual(await page.evaluate(() => {
      const fs = window.playground!.fs;
      return { mode: fs.vfs.mode, persistent: fs.vfs.persistent };
    }), { mode: mode ?? "fast", persistent: mode !== "memory" });
    const input = page.locator(".xterm-helper-textarea");
    await input.pressSequentially("help > /tmp/filesystem-info.txt");
    await input.press("Enter");
    await page.waitForFunction(async () => {
      const fs = window.playground?.fs;
      if (!fs || !await fs.lookup("/tmp/filesystem-info.txt")) return false;
      return new TextDecoder().decode(await fs.readFile("/tmp/filesystem-info.txt")).includes("filesystem:");
    });
    const output = await page.evaluate(async () => new TextDecoder().decode(await window.playground!.fs.readFile("/tmp/filesystem-info.txt")));
    const storage = mode === "memory" ? "memory-only browser storage" : "persistent browser storage";
    const durability = mode === "memory" ? "do not survive" : "survive";
    assert.ok(output.includes(`filesystem: ${storage}, preopened at /, cwd /home/user; editor saves ${durability} reload`), output);
    if (mode === "memory") assert.doesNotMatch(output, /persistent browser storage|editor saves survive reload/);
    console.log(`ok ${engine} playground: ${mode ?? "default fast"} shell help reports ${storage}; editor saves ${durability} reload`);
  } finally { await context.close(); }
}

async function fastWaitCheck(base: string) {
  // The test-owned filesystem requests Waffle's supported waiting policy, not a
  // product backend selector. The page and IndexedDB worker remain real.
  const context = await browser!.newContext();
  const errors: string[] = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  try {
    const owner = await context.newPage();
    await owner.goto(`${base}/playground/?mode=fast&wait-startup=1`);
    await owner.waitForFunction(() => !!(globalThis as any).playground?.editor || document.querySelector<HTMLElement>("#status")?.dataset.kind === "error");
    assert.equal(await owner.evaluate(() => !!(globalThis as any).playground?.editor), true, await owner.locator("#status").innerText());
    await owner.evaluate(async () => {
      const fs = (globalThis as any).playground.fs;
      await fs.writeFile("/home/user/index.ts", "console.log('queued owner save');");
      await fs.flush();
    });
    const waiting = await context.newPage();
    await waiting.goto(`${base}/playground/?mode=fast&wait-startup=1`);
    await waiting.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Waiting for this workspace to close in another tab."));
    assert.deepEqual(await owner.evaluate(() => {
      const fs = window.playground?.fs;
      if (!fs) throw new Error("Waiting control displaced its owner");
      return { mode: fs.vfs.mode, implementation: fs.vfs.implementation, state: fs.state.status, ownershipLost: fs.ownershipLost };
    }), { mode: "fast", implementation: "indexeddb", state: "ready", ownershipLost: false });
    assert.equal(await waiting.locator("#editor .cm-editor").count(), 0);
    for (const selector of ["#run", "#new-file", "#engine", "#file-select"]) {
      assert.equal(await waiting.locator(selector).isDisabled(), true);
    }
    await waiting.evaluate(() => { (globalThis as any).queuedDocument = crypto.randomUUID(); });
    const documentId = await waiting.evaluate(() => (globalThis as any).queuedDocument);
    await owner.close();
    await waiting.waitForFunction(() => !!(globalThis as any).playground?.editor);
    assert.equal(await waiting.evaluate(() => (globalThis as any).queuedDocument), documentId);
    assert.equal(await waiting.evaluate(async () => new TextDecoder().decode(await (globalThis as any).playground.fs.readFile("/home/user/index.ts"))), "console.log('queued owner save');");
    for (const selector of ["#run", "#new-file", "#engine", "#file-select"]) {
      assert.equal(await waiting.locator(selector).isEnabled(), true);
    }
    assert.deepEqual(errors, []);
    console.log(`ok ${engine} playground: fast IndexedDB waiting UI, disabled startup controls, automatic readiness without reload and durable saves`);
  } finally { await context.close(); }
}

async function unsupportedModeChecks(base: string): Promise<void> {
  for (const app of ["playground", "sandbox"]) {
    for (const mode of ["safe", "invalid"]) await unsupportedModeCheck(base, app, mode);
  }
}

async function unsupportedModeCheck(base: string, app: string, mode: string): Promise<void> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/${app}/?mode=${mode}&wait-startup=1`);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")?.dataset.kind === "error");
    assert.match(await page.locator("#status").innerText(), /UNSUPPORTED_VFS/);
    assert.match(await page.locator("#status").innerText(), new RegExp(mode));
    assert.equal(await page.locator("#editor .cm-editor").count(), 0);
    assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name)), []);
    assert.equal(await page.locator(app === "sandbox" ? "#restart" : "#run").innerText(), "Reload");
    console.log(`ok ${engine} ${app}: ${mode} has a typed startup refusal, no editor or database, even with the waiting control`);
  } finally { await context.close(); }
}

async function startupFailureCheck(base: string) {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${base}/playground/?fail-startup=1`);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")?.dataset.kind === "error");
    assert.match(await page.locator("#status").innerText(), /injected filesystem startup failure/);
    assert.doesNotMatch(await page.locator("#status").innerText(), /opened in another tab/);
    assert.equal(await page.evaluate(() => !!(globalThis as any).playground?.editor), false);
    const reload = page.locator("#run");
    assert.equal(await reload.innerText(), "Reload");
    assert.equal(await reload.isEnabled(), true);
    for (const selector of ["#new-file", "#engine", "#file-select"]) {
      assert.equal(await page.locator(selector).isDisabled(), true);
    }
    await Promise.all([page.waitForNavigation({ timeout: 4_000 }), reload.click()]);
    await page.waitForFunction(() => !!(globalThis as any).playground?.editor);
    assert.equal(await page.locator("#run").isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log(`ok ${engine} playground: ordinary filesystem startup failure has a working Reload and recovers`);
  } finally { await context.close(); }
}

async function startupStealChecks(base: string) {
  for (const app of ["sandbox", "playground"]) {
    for (const rejectPending of [false, true]) await startupSteal(base, app, rejectPending);
  }
}
async function startupSteal(base: string, app: string, rejectPending: boolean) {
  const context = await browser!.newContext();
  const owner = await context.newPage();
  const errors: string[] = [];
  owner.on("pageerror", error => errors.push(error.message));
  try {
    await owner.goto(`${base}/${app}/?pause-startup=1`);
    await owner.waitForFunction(() => (globalThis as any).startupFilesystem?.paused);
    const contender = await context.newPage();
    await contender.goto(`${base}/${app}/`);
    await contender.waitForFunction(app => !!(globalThis as any)[app]?.editor, app);
    await contender.evaluate(async app => {
      const fs = (globalThis as any)[app].fs;
      await fs.writeFile("/startup-saved", "saved during takeover"); await fs.flush();
    }, app);
    await owner.bringToFront();
    await owner.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("This workspace was opened in another tab."));
    if (rejectPending) await owner.evaluate(() => (globalThis as any).startupFilesystem.resume());
    const button = owner.locator(app === "sandbox" ? "#restart" : "#run");
    await button.waitFor();
    assert.equal(await button.innerText(), "Reload");
    assert.equal(await button.isEnabled(), true);
    if (process.env.STARTUP_ERROR_SCREENSHOT) await owner.screenshot({ path: `${process.env.STARTUP_ERROR_SCREENSHOT}-${app}-${rejectPending ? "rejected" : "pending"}.png` });
    await Promise.all([owner.waitForNavigation({ timeout: 4_000 }), button.click()]);
    await owner.waitForFunction(app => !!(globalThis as any)[app]?.editor, app);
    assert.equal(await owner.evaluate(async app => new TextDecoder().decode(await (globalThis as any)[app].fs.readFile("/startup-saved")), app), "saved during takeover");
    assert.deepEqual(errors, []);
    console.log(`ok ${engine} ${app}: startup steal ${rejectPending ? "rejection" : "pending request"}, complete error and working Reload`);
  } finally { await context.close(); }
}

async function openEditorFile(page: Page, path: string): Promise<void> {
  await page.locator("#file-select").selectOption(path);
  await page.waitForFunction(path => document.querySelector("#file-name")?.textContent === path, path);
  assert.ok(await page.locator(".cm-content span[class]").count() > 0, `${path}: syntax highlighting`);
}

async function languageChecks(base: string, languageAssets: Set<string>, requests: string[]): Promise<void> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  try {
    const start = requests.length;
    await page.goto(`${base}/sandbox/`);
    await page.waitForFunction(() => document.querySelector("#file-name")?.textContent === "src/App.tsx");
    assert.deepEqual(requests.slice(start).filter(path => languageAssets.has(path)), []);
    await openEditorFile(page, "src/App.css");
    await page.locator(".cm-content").fill("h1 { color: red; }");
    await page.locator(".cm-content").press("ControlOrMeta+s");
    await page.waitForFunction(() => document.querySelector("#save-state")?.textContent === "saved");
    await openEditorFile(page, "index.html");
    await openEditorFile(page, "src/App.tsx");
    await openEditorFile(page, "src/App.css");
    assert.equal(await page.locator(".cm-content").innerText(), "h1 { color: red; }");
    assert.ok(requests.slice(start).some(path => languageAssets.has(path)));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#file-name")?.textContent === "src/App.tsx");
    await openEditorFile(page, "src/App.css");
    assert.equal(await page.locator(".cm-content").innerText(), "h1 { color: red; }");
    console.log(`ok ${engine} sandbox: lazy CSS/HTML highlighting, TypeScript switch-back, saved edit and reload`);
  } finally { await context.close(); }
}

try {
  scratch = await mkdtemp(join(process.env.EDITOR_SCRATCH_ROOT ?? tmpdir(), "bw-editor-"));
  process.env.TMPDIR = scratch;
  for (const app of ["sandbox", "web"]) {
    const prefix = app === "web" ? "/playground" : "/sandbox";
    const outdir = join(scratch, app);
    let filesystemOwners = 0;
    const build = await Bun.build({
      outdir,
      entrypoints: [join(root, app, "src/main.ts"), join(root, "web/src/fs-worker.ts")],
      target: "browser", format: "esm", splitting: true,
      naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
      plugins: [{
        name: "artifact-free-editor-host",
        setup(build) {
          // Keep the page runtime and real filesystem worker. Pause the filesystem it
          // actually owns, not the old web re-export used only for message constants.
          build.onResolve({ filter: /^\.\/browser\/shared-fs\.js$/ }, () => {
            filesystemOwners++;
            return { path: join(root, "web/tests/fixtures/startup-filesystem.ts") };
          });
          // Only the engine and preview host are replaced; editor/startup/save code ships unchanged.
          build.onLoad({ filter: /\/web\/src\/engine-loader\.ts$/ }, () => ({ loader: "ts", contents: `
            export const ENGINES = Object.fromEntries(["browser", "quickjs", "jsc"].map(key => [key, { name: key, wasm: "not-built.wasm" }]));
            export class WasmMissing extends Error {}
            export const isEngine = (key) => Object.hasOwn(ENGINES, key);
            export async function loadWasm() { throw new WasmMissing("Artifact-free editor test"); }
            export async function registerModuleScope() { return false; }
            export const mb = (size) => String(size);
          ` }));
          build.onLoad({ filter: /\/web\/src\/runner\.ts$/ }, () => ({ loader: "ts", contents: `
            export function startRun() { throw new Error("This test must not start a guest"); }
          ` }));
          build.onLoad({ filter: /\/web\/src\/preview\.ts$/ }, () => ({ loader: "ts", contents: `
            export class Previews { ready = Promise.resolve("disabled in editor test"); }
          ` }));
        },
      }],
    });
    assert.equal(build.success, true, build.logs.map(String).join("\n"));
    assert.equal(filesystemOwners, 1, `${app}: startup gate must instrument the runtime-owned filesystem`);
    for (const output of build.outputs) {
      const path = `${prefix}/${output.path.slice(outdir.length + 1)}`;
      assets.set(path, output);
      if (/node_modules\/@codemirror\/lang-(?:css|html)\//.test(await output.text())) languageAssets.add(path);
    }
    assets.set(`${prefix}/`, Bun.file(join(root, app, "index.html")));
  }
  assets.set("/sandbox/template.json", new Blob([JSON.stringify({ files: {
    "index.html": "<!doctype html><h1>Editor persistence test</h1>",
    "src/App.tsx": "export default 'original template';",
    "src/App.css": "h1 { color: blue; }",
    "deleted.ts": "delete me",
    "package.json": "{}",
  } })], { type: "application/json" }));
  server = Bun.serve({
    hostname: "127.0.0.1", port: Number(process.env.EDITOR_PORT ?? 0),
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
      if (path === "/favicon.ico") return new Response(null, { status: 204, headers });
      const asset = assets.get(path);
      return asset ? new Response(asset, { headers }) : new Response("Not found", { status: 404, headers });
    },
  });
  browserLaunch = browserType.launch({ headless: true, downloadsPath: join(scratch, "downloads"), tracesDir: join(scratch, "traces") });
  browser = await browserLaunch;
  await languageChecks(`http://127.0.0.1:${server.port}`, languageAssets, requests);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(`Page error: ${error.message}`); });
  page.on("response", response => { if (response.status() >= 400) console.error(`HTTP ${response.status()}: ${response.url()}`); });
  const base = `http://127.0.0.1:${server.port}`;

  for (const mode of ["memory", "fast", null] as const) await filesystemInfoCheck(base, mode);
  await unsupportedModeChecks(base);
  await startupFailureCheck(base);
  await startupStealChecks(base);
  await fastWaitCheck(base);
  if (process.env.STARTUP_STEAL_ONLY !== "1") {
  await page.goto(`${base}/sandbox/`);
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  await page.evaluate(async () => {
    const { editor, fs } = (globalThis as any).sandbox;
    editor.setText("export default 'saved edit';");
    await editor.flush("src/App.tsx");
    await fs.remove("/home/user/app/deleted.ts");
    await fs.writeFile("/home/user/app/custom.ts", "custom file");
    await fs.flush();
  });
  assert.equal(await page.locator("#save-state").innerText(), "saved");
  // No delay: the page is discarded immediately after its durable save resolves.
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    return {
      text: new TextDecoder().decode(await fs.readFile("/home/user/app/src/App.tsx")),
      deleted: await fs.lookup("/home/user/app/deleted.ts"),
      custom: new TextDecoder().decode(await fs.readFile("/home/user/app/custom.ts")),
    };
  }), { text: "export default 'saved edit';", deleted: undefined, custom: "custom file" });
  // Fail an actual reset after the first seed write, persist that prefix, then discard
  // the page. The next startup must finish the reset, not accept APP as a complete seed.
  await page.evaluate(() => (globalThis as any).startupFilesystem.failWriteAfter(2));
  page.once("dialog", dialog => { void dialog.accept(); });
  await page.locator("#reset").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("interrupted reset"));
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    await fs.flush();
    if (await fs.lookup("/home/user/app/.bunwasm-initialized")) throw new Error("Partial reset published its completion marker");
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.equal(await page.evaluate(async () => new TextDecoder().decode(await (globalThis as any).sandbox.fs.readFile("/home/user/app/src/App.tsx"))), "export default 'original template';");
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    await fs.writeFile("/home/user/app/custom.ts", "reset removes me");
    await fs.flush();
  });
  page.once("dialog", dialog => { void dialog.accept(); });
  await Promise.all([page.waitForEvent("load"), page.locator("#reset").click()]);
  await page.waitForFunction(() => (globalThis as any).sandbox?.editor.path === "src/App.tsx");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).sandbox;
    return {
      text: new TextDecoder().decode(await fs.readFile("/home/user/app/src/App.tsx")),
      deletedRestored: !!await fs.lookup("/home/user/app/deleted.ts"),
      custom: await fs.lookup("/home/user/app/custom.ts"),
    };
  }), { text: "export default 'original template';", deletedRestored: true, custom: undefined });
  // Exercise the responsive reset control with the actual stylesheet.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#reset").isVisible(), true);
  if (process.env.EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.EDITOR_SCREENSHOT });

  await page.goto(`${base}/playground/`);
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  // Simulate the durable image left if background persistence ran halfway through seed.
  await page.evaluate(async () => {
    const { fs } = (globalThis as any).playground;
    await fs.remove("/home/user");
    await fs.mkdirp("/home/user");
    await fs.writeFile("/home/user/index.ts", "partial seed");
    await fs.flush();
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.equal(await page.evaluate(async () => !!await (globalThis as any).playground.fs.lookup("/home/user/math.test.ts")), true);
  await page.evaluate(async () => {
    const { editor, fs } = (globalThis as any).playground;
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "console.log('saved playground');" } });
    await editor.save();
    await fs.remove("/home/user/math.test.ts");
    await fs.flush();
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.deepEqual(await page.evaluate(async () => {
    const { fs } = (globalThis as any).playground;
    return { text: new TextDecoder().decode(await fs.readFile("/home/user/index.ts")), deleted: await fs.lookup("/home/user/math.test.ts") };
  }), { text: "console.log('saved playground');", deleted: undefined });

  await page.evaluate(() => {
    const editor = (globalThis as any).playground.editor;
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "unsaved older tab" } });
  });
  const contender = await context.newPage();
  const startupErrors: string[] = [];
  contender.on("pageerror", error => startupErrors.push(error.message));
  await contender.goto(`${base}/playground/`);
  await contender.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.equal(await contender.evaluate(async () => new TextDecoder().decode(await (globalThis as any).playground.fs.readFile("/home/user/index.ts"))), "console.log('saved playground');");
  await page.bringToFront();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => (globalThis as any).playground.fs.ownershipLost);
  assert.match(await page.locator("#status").innerText(), /This workspace was opened in another tab. Reload to continue here./);
  assert.match(await page.locator("#status").innerText(), /Unsaved changes in this tab weren't kept./);
  assert.equal(await page.evaluate(() => (globalThis as any).playground.editor.view.state.doc.toString()), "unsaved older tab");
  assert.deepEqual(await page.locator("#status").evaluate(element => ({
    wrapping: getComputedStyle(element).whiteSpace,
    clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
  })), { wrapping: "pre-wrap", clipped: false });
  assert.equal(await page.locator("#run").innerText(), "Reload");
  assert.equal(await page.locator("#run").isEnabled(), true);
  assert.equal(await page.locator("#new-file").isDisabled(), true);
  assert.equal(await page.locator("#engine").isDisabled(), true);
  assert.equal(await page.locator("#file-select").isDisabled(), true);
  assert.deepEqual(startupErrors, []);
  if (process.env.STARTUP_ERROR_SCREENSHOT) await page.screenshot({ path: process.env.STARTUP_ERROR_SCREENSHOT });
  await contender.close();
  await page.locator("#run").click();
  await page.waitForFunction(() => (globalThis as any).playground?.editor.path === "/home/user/index.ts");
  assert.equal(await page.evaluate(async () => new TextDecoder().decode(await (globalThis as any).playground.fs.readFile("/home/user/index.ts"))), "console.log('saved playground');");
  assert.deepEqual(errors, []);
  console.log(`${engine} ${browser.version()}: durable saves, reload, seed/reset recovery, complete mobile startup errors, newest writer wins and displaced edits remain visible passed`);
  }
} finally {
  clearTimeout(timeout);
  await cleanup();
}
