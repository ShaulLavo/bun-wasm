import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFiles } from "./apps.mjs";
import { checkCommand, checkInstall } from "./checks.mjs";
import { boundedCleanup, closeOwnedBrowser, closeOwnedContext, HarnessCleanupError, withCleanupFailures } from "./cleanup.ts";
import { browserDiagnostics } from "./browser-diagnostics.ts";
import { verifyBrowserServer, stoppedPreviewError } from "./server-browser.ts";
import { observeHmr } from "./hmr.ts";
import { observeProductTraffic, productObservations } from "./product-browser.ts";
import { failure, stageOutput } from "./classify.ts";
import { BlockedBrowserNetworkError } from "./product-campaign.ts";
import { browserRegistryRoute } from "./registry-request.ts";
import { observePreviewPaths, readPreviewPaths, readPreviewPorts } from "./preview-paths.ts";
import { browserCommand, browserLauncher, resetBrowserProject } from "./browser-environment.ts";

export function earlyServerExit(command, stage) {
  const classified = failure(command.output, stage);
  if (!command.output.trim()) classified.blocker = `Server exited ${command.code} before HTTP/DOM assertion`;
  return { status: "fail", exit: command.code, ...classified };
}

const since = started => Math.round(performance.now() - started);

function guestSource(page) {
  return {
    read: path => readGuest(page, path),
    write: (path, contents) => page.evaluate(([path, contents]) => globalThis.playground.fs.writeFile(`/home/user/${path}`, contents), [path, contents]),
  };
}

async function recordPreviewPaths({ enabled, owner, preview, url, since, output, observations }) {
  if (!enabled) return;
  const browserPath = await preview.evaluate(() => location.pathname);
  const forwarded = (await owner.evaluate(readPreviewPaths)).filter(entry => entry.sequence > since && entry.port === 3137 && entry.method === "GET" && new URL(entry.target, url).pathname === "/");
  writeFileSync(output, JSON.stringify({ browserPath, forwarded }, null, 2) + "\n");
  if (browserPath !== "/" || !forwarded.length) throw new Error("Root preview caller/server paths did not agree");
  observations.push({ stage: "root-paths", status: "pass", assertion: `Caller pathname /; actual forwarded server request targets: ${forwarded.map(entry => entry.target).join(", ")}` });
}

export async function serverCommand({ page, context, command, app, engine, options, terminalText }) {
  const text = browserCommand(command.args.map(arg => arg.replaceAll("{port}", "3137"))).join(" ");
  const started = performance.now();
  const portBaseline = options.previewOrigins ? await page.evaluate(readPreviewPorts) : [];
  const pathStart = options.previewOrigins ? (await page.evaluate(readPreviewPaths)).at(-1)?.sequence ?? 0 : 0;
  const timings = {};
  await page.evaluate(text => {
    globalThis.__matrixDone = false;
    globalThis.__matrixCommand = globalThis.playground.shell.submit(text).finally(() => { globalThis.__matrixDone = true; });
  }, text);
  const deadline = Date.now() + options.timeout;
  const output = async () => stageOutput(await terminalText(page), text);
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({ done: globalThis.__matrixDone, serving: globalThis.playground.previews.serves(3137) }));
    if (state.done) return earlyServerExit({ code: await page.evaluate(() => globalThis.playground.shell.lastExit), output: await output() }, command.name);
    if (state.serving) { timings.readyMs = since(started); break; }
    await page.waitForTimeout(100);
  }
  const preview = await context.newPage();
  const traffic = await observeProductTraffic(preview);
  const errors = [];
  preview.on("pageerror", error => errors.push(String(error)));
  let checked;
  let url;
  let captured = false;
  const cleanupFailures = [];
  const cleanupTimeout = options.cleanupTimeout ?? 10_000;
  const release = async (operation, cleanup, timeout = cleanupTimeout) => {
    const failed = await boundedCleanup(operation, cleanup, timeout);
    if (failed) cleanupFailures.push(failed);
  };
  const verifyStopped = async () => {
    const error = await stoppedPreviewError(preview, url, options.timeout, join(options.output, `${app.id}-${engine}-stopped.json`), options.previewOrigins ? "root" : "mounted");
    if (error) checked = { status: "fail", ...failure(error, command.name) };
    else {
      const ports = options.previewOrigins ? await page.evaluate(readPreviewPorts) : [];
      const leftover = ports.filter(port => !portBaseline.includes(port));
      if (leftover.length) throw new Error(`Guest stop retained virtual preview ports: ${leftover.join(", ")}`);
      checked.assertion += "; guest stop removes preview listeners";
    }
  };
  try {
    const previewState = await page.evaluate(() => globalThis.playground.previews.ready);
    if (previewState !== "ready") throw new Error(`Preview service worker is ${previewState}`);
    url = await page.evaluate(() => globalThis.playground.previews.url(3137));
    const loading = performance.now();
    const response = await preview.goto(url, { timeout: options.timeout });
    if (!response?.ok()) throw new Error(`Preview HTTP ${response?.status()}`);
    const check = command.check;
    if (options.previewOrigins) {
      if (response.fromServiceWorker() || new URL(url).pathname !== "/" || new URL(url).origin === new URL(page.url()).origin) throw new Error("Root preview did not use its dedicated host origin");
    } else if (!response.fromServiceWorker()) throw new Error("Preview response bypassed the service worker");
    await preview.locator(check.kind === "http" ? "body" : check.selector).filter({ hasText: check.text }).waitFor({ timeout: options.timeout });
    timings.pageLoadMs = since(loading);
    const contract = check.framework ? await verifyBrowserServer(preview, url, check.framework, options.timeout, join(options.output, `${app.id}-${engine}-requests.json`), options.previewOrigins ? "root" : "mounted") : "";
    if (errors.length) throw new Error(errors.join("\n"));
    if (await page.evaluate(() => globalThis.__matrixDone)) {
      checked = earlyServerExit({ code: await page.evaluate(() => globalThis.playground.shell.lastExit), output: await output() }, command.name);
    } else {
      await preview.screenshot({ path: join(options.output, `${app.id}-${engine}-playground-${command.name}.png`) });
      const observations = await productObservations(preview, url, check, guestSource(page), traffic, options.timeout);
      await recordPreviewPaths({ enabled: options.previewOrigins, owner: page, preview, url, since: pathStart, output: join(options.output, `${app.id}-${engine}-${command.name}-paths.json`), observations });
      checked = { status: "pass", assertion: `${options.previewOrigins ? "Root-origin" : "Service-worker"} preview renders ${JSON.stringify(check.text)}${contract ? `; ${contract}` : ""}`, observations, timings };
    }
  } catch (error) {
    let diagnostic = "";
    captured = true;
    await release("terminal-capture", async () => { diagnostic = await output(); });
    checked = { status: "fail", ...failure(`${diagnostic}\n${String(error)}`, command.name), productError: String(error), timings };
  } finally {
    if (!captured) await release("terminal-capture", () => terminalText(page));
    await release("server-stop", () => page.evaluate(async () => { globalThis.playground.shell.input("\x03"); await globalThis.__matrixCommand; }));
    if (!cleanupFailures.length && checked?.status === "pass" && (command.check.framework || options.previewOrigins)) {
      await release("stopped-preview", verifyStopped, options.timeout);
    }
    await release("traffic-close", () => traffic.close());
    await release("preview-close", () => preview.close());
  }
  return withCleanupFailures(checked, cleanupFailures);
}


/** A guest file's text from the playground's shared filesystem, or null when it is missing. */
export async function readGuest(page, path) {
  return page.evaluate(async path => {
    const bytes = await globalThis.playground.fs.readFile(`/home/user/${path}`);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, path);
}

export async function browserHost({ root, options, launch, stop }) {
  const playwrightPath = process.env.PLAYWRIGHT ?? join(root, "web/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const { ready, run, terminalText, writeFile } = await import(pathToFileURL(join(root, "web/tests/playground.mjs")).href);
  let browser;
  let browserServer;
  let server;
  let base;
  const cleanupTimeout = options.cleanupTimeout ?? 10_000;
  const getBrowser = async () => {
    if (browser) return browser;
    browserServer = await chromium.launchServer();
    browser = await chromium.connect(browserServer.wsEndpoint());
    return browser;
  };

  const closeContext = (context, cause) => closeOwnedContext(context, browserServer, cleanupTimeout, cause);

  async function serve() {
    if (base) return base;
    const logfile = join(options.output, "playground-server.log");
    server = launch(["bun", join(root, "web/serve.ts")], root, logfile, { PORT: "0", PREVIEW_ORIGINS: options.previewOrigins ? "1" : "0" });
    for (let i = 0; i < 200; i++) {
      const match = readFileSync(logfile, "utf8").match(/at (http:\/\/\S+)/);
      if (match) { base = options.previewOrigins ? `${match[1]}?root-previews` : match[1]; return base; }
      if (server.child.exitCode !== null) throw new Error("Playground server exited");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Playground did not start");
  }

  async function checkPage(url, check, project, timeout = options.timeout) {
    const page = await (await getBrowser()).newPage();
    const verifyHmr = observeHmr(page);
    const diagnostics = browserDiagnostics(page);
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    let checked;
    let productError;
    try {
      await page.goto(url, { timeout: remaining() });
      await page.locator(check.selector).filter({ hasText: check.text }).waitFor({ timeout: remaining() });
      const hmr = check.hmr && await verifyHmr(project, check.selector, check.hmr, remaining(), () => page.screenshot({ path: join(options.output, `${basename(project)}-dev.png`) }));
      if (errors.length) throw new Error(errors.join("\n"));
      checked = { status: "pass", assertion: `${check.selector} renders ${JSON.stringify(check.text)}${hmr ? `; ${hmr}` : ""}` };
    } catch (error) {
      productError = error;
      checked = { status: "fail", timedOut: error?.name === "TimeoutError", ...failure(String(error), "server"), productError: String(error), browserDiagnostics: diagnostics() };
    }
    try { await closeContext(page.context(), productError); }
    catch (error) {
      if (!(error instanceof HarnessCleanupError)) throw error;
      checked = withCleanupFailures(checked, error.failures);
    }
    return checked;
  }

  async function commandResult(page, context, app, engine, command, captureTerminal) {
    if (["http", "page"].includes(command.check.kind)) return serverCommand({ page, context, command, app, engine, options, terminalText: captureTerminal });
    const started = performance.now();
    const runResult = await run(page, browserCommand(command.args).join(" "), options.timeout);
    const timings = { commandMs: since(started) };
    return { ...await checkCommand(command, runResult, path => readGuest(page, path)), timings };
  }

  async function runApp({ app, engine, registry, record }) {
    const context = await (await getBrowser()).newContext({ serviceWorkers: "allow" });
    let page;
    const external = [];
    let primaryError;
    const captureTerminal = async page => {
      const terminal = await terminalText(page);
      writeFileSync(join(options.output, `${app.id}-${engine}-playground.log`), terminal);
      return terminal;
    };
    const outcomes = new Map();
    try {
      page = await context.newPage();
      await context.route("**/*", route => browserRegistryRoute(route, registry, external));
      const base = await serve();
      const loading = performance.now();
      const playgroundURL = new URL(base);
      playgroundURL.searchParams.set("engine", engine);
      await page.goto(playgroundURL.href);
      if (!(await ready(page)).includes("ready")) throw new Error(`Playground engine ${engine} failed to load`);
      const engineReadyMs = since(loading);
      if (options.previewOrigins) await page.evaluate(observePreviewPaths);
      await page.evaluate(resetBrowserProject);
      for (const [path, contents] of Object.entries(projectFiles(app, registry))) await writeFile(page, `/home/user/${path}`, contents);
      await writeFile(page, "/home/user/.matrix-command.ts", browserLauncher);
      const installing = performance.now();
      const installed = await run(page, "bun install", options.timeout);
      const timings = { engineReadyMs, commandMs: since(installing) };
      const install = record(app, engine, "playground", "install", ["bun", "install"], { ...await checkInstall(app, installed, path => readGuest(page, path)), timings });
      for (const command of app.commands) {
        const prerequisite = command.after ? outcomes.get(command.after) : install;
        const checked = prerequisite.status === "pass" ? await commandResult(page, context, app, engine, command, captureTerminal) : { status: "blocked", category: prerequisite.category, blocker: prerequisite.blocker, prerequisite: command.after ?? "install" };
        outcomes.set(command.name, checked);
        record(app, engine, "playground", command.name, ["bun"].concat(command.args), checked);
        if (checked.harnessCleanup) throw new HarnessCleanupError(checked.harnessCleanup, checked.productError);
      }
      const captureFailed = await boundedCleanup("terminal-capture", () => captureTerminal(page), cleanupTimeout);
      if (captureFailed) throw new HarnessCleanupError([captureFailed]);
      if (external.length) throw new BlockedBrowserNetworkError(external);
    } catch (error) {
      primaryError = error;
      if (page && !(error instanceof HarnessCleanupError)) {
        const failed = await boundedCleanup("terminal-capture", () => captureTerminal(page), cleanupTimeout);
        if (failed) throw new HarnessCleanupError([failed], error);
      }
      throw error;
    } finally { await closeContext(context, primaryError); }
  }

  return {
    runApp, checkPage,
    async close() {
      if (server) stop(server.child);
      const releases = [
        browserServer && boundedCleanup("browser-release", () => closeOwnedBrowser(browserServer, cleanupTimeout), cleanupTimeout * 3),
        server && boundedCleanup("server-exit", () => server.done, cleanupTimeout),
      ];
      const failed = (await Promise.all(releases)).filter(Boolean);
      if (failed.length) throw new HarnessCleanupError(failed);
    },
  };
}
