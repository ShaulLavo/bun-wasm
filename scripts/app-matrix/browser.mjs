import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFiles } from "./apps.mjs";

export async function browserHost({ root, options, launch, stop }) {
  const playwrightPath = process.env.PLAYWRIGHT ?? "/home/shaul/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const { ready, run, terminalText, writeFile } = await import(pathToFileURL(join(root, "web/tests/playground.mjs")).href);
  let browser;
  let server;
  let base;
  const getBrowser = async () => browser ??= await chromium.launch();

  async function serve() {
    if (base) return base;
    const logfile = join(options.output, "playground-server.log");
    server = launch(["bun", join(root, "web/serve.ts")], root, logfile, { PORT: "0" });
    for (let i = 0; i < 200; i++) {
      const match = readFileSync(logfile, "utf8").match(/at (http:\/\/\S+)/);
      if (match) { base = match[1]; return base; }
      if (server.child.exitCode !== null) throw new Error("Playground server exited");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Playground did not start");
  }

  async function checkPage(url, check) {
    const page = await (await getBrowser()).newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(url, { timeout: options.timeout });
      await page.locator(check.selector).filter({ hasText: check.text }).waitFor({ timeout: options.timeout });
      if (errors.length) throw new Error(errors.join("\n"));
      return { status: "pass", assertion: `${check.selector} renders ${JSON.stringify(check.text)}` };
    } finally { await page.close(); }
  }

  function result(command) {
    if (command.code === 0) return { status: "pass", exit: 0 };
    const lines = command.output.split("\n").filter(Boolean);
    const blocker = lines.find(line => /error|unsupported|not found|not implemented|cannot|failed/i.test(line)) ?? lines.at(-1) ?? "Command deadline exceeded";
    return { status: "fail", exit: command.code, category: "d", blocker: blocker.slice(0, 500) };
  }

  async function serverCommand(page, context, command, app, engine) {
    const text = ["bun"].concat(command.args.map(arg => arg.replaceAll("{port}", "3137"))).join(" ");
    await page.evaluate(text => {
      globalThis.__matrixDone = false;
      globalThis.__matrixCommand = globalThis.playground.shell.submit(text).finally(() => { globalThis.__matrixDone = true; });
    }, text);
    const deadline = Date.now() + options.timeout;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({ done: globalThis.__matrixDone, serving: globalThis.playground.previews.serves(3137) }));
      if (state.done) return result({ code: await page.evaluate(() => globalThis.playground.shell.lastExit), output: await terminalText(page) });
      if (state.serving) break;
      await page.waitForTimeout(100);
    }
    const preview = await context.newPage();
    const errors = [];
    preview.on("pageerror", error => errors.push(String(error)));
    try {
      const url = await page.evaluate(() => globalThis.playground.previews.url(3137));
      const response = await preview.goto(url, { timeout: options.timeout });
      if (!response?.ok()) throw new Error(`Preview HTTP ${response?.status()}`);
      const check = command.check;
      await preview.locator(check.kind === "http" ? "body" : check.selector).filter({ hasText: check.text }).waitFor({ timeout: options.timeout });
      if (errors.length) throw new Error(errors.join("\n"));
      await preview.screenshot({ path: join(options.output, `${app.id}-${engine}-playground-${command.name}.png`) });
      return { status: "pass", assertion: `Service-worker preview renders ${JSON.stringify(check.text)}` };
    } catch (error) {
      return { status: "fail", category: "d", blocker: String(error).slice(0, 500) };
    } finally {
      await preview.close();
      await page.evaluate(async () => { globalThis.playground.shell.input("\x03"); await globalThis.__matrixCommand; });
    }
  }

  async function commandResult(page, context, app, engine, command) {
    if (["http", "page"].includes(command.check.kind)) return serverCommand(page, context, command, app, engine);
    const runResult = await run(page, ["bun"].concat(command.args).join(" "), options.timeout);
    const checked = result(runResult);
    if (checked.status !== "pass") return checked;
    if (command.check.kind === "stdout" && !runResult.output.includes(command.check.text)) return { status: "fail", category: "d", blocker: `Missing output ${command.check.text}` };
    if (command.check.kind !== "files") return checked;
    const files = await page.evaluate(paths => paths.map(path => {
      const bytes = globalThis.playground.fs.readFile(`/home/user/${path}`);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }), command.check.paths);
    if (files.some(content => !content?.length || !content.includes(command.check.text))) return { status: "fail", category: "d", blocker: "Missing or invalid build output" };
    return { ...checked, assertion: JSON.stringify(command.check) };
  }

  async function runApp({ app, engine, registry, record }) {
    const context = await (await getBrowser()).newContext();
    const page = await context.newPage();
    const external = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
      external.push(url.href);
      return route.abort();
    });
    try {
      await page.goto(`${await serve()}?engine=${engine}`);
      if (!(await ready(page)).includes("ready")) throw new Error(`Playground engine ${engine} failed to load`);
      for (const [path, contents] of Object.entries(projectFiles(app, registry))) await writeFile(page, `/home/user/${path}`, contents);
      const installed = await run(page, "bun install", options.timeout);
      const install = record(app, engine, "playground", "install", ["bun", "install"], result(installed));
      for (const command of app.commands) {
        const checked = install.status === "pass" ? await commandResult(page, context, app, engine, command) : { status: "blocked", category: install.category, blocker: install.blocker, prerequisite: "install" };
        record(app, engine, "playground", command.name, ["bun"].concat(command.args), checked);
      }
      writeFileSync(join(options.output, `${app.id}-${engine}-playground.log`), await terminalText(page));
      if (external.length) throw new Error(`Browser attempted external network: ${external.join(", ")}`);
    } finally { await context.close(); }
  }

  return {
    runApp, checkPage,
    async close() {
      await browser?.close();
      if (server) { stop(server.child); await server.done; }
    },
  };
}
