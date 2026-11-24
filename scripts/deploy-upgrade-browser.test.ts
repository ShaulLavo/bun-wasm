import { expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { chromium, firefox, webkit, type BrowserContext, type ConsoleMessage, type Page } from "playwright";
import { acceptedEncodings } from "./accept-encoding";
import { buildSite, verifySite } from "./browser-guest-site";
import { publishVersionedEntries, rewriteEntryHtml, VERSIONED_ENTRY_FILES, VERSIONED_WORKER_FILES } from "./browser-build";
import { run as runPlaygroundCommand } from "../web/tests/playground.mjs";

// Real browser install/dev + reload across two builds; timeout only catches a hang.
setDefaultTimeout(300_000);

const STARTUP_MS = 180_000;
const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");

interface RotatedApp {
  oldChunk: string;
  buildAEntries: Record<string, string>;
  buildBEntries: Record<string, string>;
  buildASwVersion: string;
  buildBSwVersion: string;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function readEmbeddedJson(dir: string, symbol: string): Record<string, string> {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const match = new RegExp(`globalThis\\.${symbol}=(\\{[^;]*?\\})(?:;|<\\/script>)`).exec(html);
  if (!match?.[1]) throw new Error(`Missing embedded ${symbol} in ${dir}/index.html`);
  return JSON.parse(match[1]) as Record<string, string>;
}

function rewriteChunkReferences(dir: string, renames: ReadonlyMap<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const path = join(dir, name);
    let text = readFileSync(path, "utf8");
    const original = text;
    for (const [before, after] of renames) text = text.replaceAll(before, after);
    if (text !== original) writeFileSync(path, text);
  }
}

/**
 * Produces Build B for one built app directory (`sandbox` or `web`) by rotating every chunk under
 * `chunks/` and `__bunwasm/chunks/`, mutating every entry + `sw.js` so all hashes change,
 * rewriting imports inside built JS files, and regenerating `entry-*`, `engine-builds.json`, and
 * `index.html`. Every Build A chunk and hashed entry URL 404s in Build B.
 */
async function rotateAppBuild(buildA: string, buildB: string, templateHtmlPath: string): Promise<RotatedApp> {
  cpSync(buildA, buildB, { recursive: true });
  const buildAEntries = {
    ...readEmbeddedJson(buildA, "__bunwasmAssets"),
    "main.js": readMainAsset(buildA, "js"),
    "main.css": readMainAsset(buildA, "css"),
  };
  const buildABuilds = readEmbeddedJson(buildA, "__bunwasmBuilds");
  const buildASwVersion = (buildABuilds["sw.js"] ?? "").slice(0, 16);

  const chunkDir = join(buildB, "chunks");
  const chunkFiles = readdirSync(chunkDir).filter(name => name.endsWith(".js")).sort();
  if (!chunkFiles.length) throw new Error(`App build ${buildB} has no JS chunks to rotate`);

  const renames = new Map<string, string>();
  for (const name of chunkFiles) {
    const rotated = name.replace(/\.js$/, "-b2.js");
    renames.set(name, rotated);
    for (const dir of [chunkDir, join(buildB, "__bunwasm/chunks")]) {
      const source = join(dir, name);
      if (await Bun.file(source).exists()) {
        await Bun.write(join(dir, rotated), await Bun.file(source).bytes());
        rmSync(source, { force: true });
      }
    }
  }

  for (const dir of [buildB, join(buildB, "__bunwasm")]) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("entry-")) rmSync(join(dir, name), { force: true });
    }
  }

  for (const dir of [buildB, join(buildB, "chunks"), join(buildB, "__bunwasm"), join(buildB, "__bunwasm/chunks")]) {
    rewriteChunkReferences(dir, renames);
  }

  // Mutate every entry and sw.js slightly so every entry hash and SW version changes in Build B.
  for (const name of [...VERSIONED_ENTRY_FILES, "sw.js"]) {
    const path = join(buildB, name);
    if (await Bun.file(path).exists()) writeFileSync(path, `${readFileSync(path, "utf8")}\n/* build-b */\n`);
  }

  const entries = await publishVersionedEntries(buildB);
  const workerAssets = Object.fromEntries(VERSIONED_WORKER_FILES.map(name => [name, entries[name]!]));
  const builds = JSON.parse(readFileSync(join(buildB, "engine-builds.json"), "utf8")) as Record<string, string>;
  builds["sw.js"] = sha256Hex(readFileSync(join(buildB, "sw.js")));
  writeFileSync(join(buildB, "engine-builds.json"), JSON.stringify(builds));

  const templateHtml = readFileSync(templateHtmlPath, "utf8");
  const commandChunksMatch = /globalThis\.__bunwasmCommandChunks=(\[[^\]]*\])/.exec(readFileSync(join(buildA, "index.html"), "utf8"));
  const rotatedCommandChunks = commandChunksMatch?.[1]
    ? JSON.stringify((JSON.parse(commandChunksMatch[1]) as string[]).map(item => {
      const slash = item.lastIndexOf("/");
      const base = slash >= 0 ? item.slice(slash + 1) : item;
      const renamed = renames.get(base);
      return renamed ? `${item.slice(0, slash + 1)}${renamed}` : item;
    }))
    : undefined;
  const bootstrap = `globalThis.__bunwasmBuilds=${JSON.stringify(builds)};globalThis.__bunwasmAssets=${JSON.stringify(workerAssets)}`
    + (rotatedCommandChunks ? `;globalThis.__bunwasmCommandChunks=${rotatedCommandChunks}` : "");
  const index = rewriteEntryHtml(templateHtml, entries).replace("<head>", `<head><script>${bootstrap}</script>`);
  writeFileSync(join(buildB, "index.html"), index);

  return {
    oldChunk: chunkFiles[0]!,
    buildAEntries,
    buildBEntries: { ...workerAssets, "main.js": entries["main.js"]!, "main.css": entries["main.css"]! },
    buildASwVersion,
    buildBSwVersion: builds["sw.js"].slice(0, 16),
  };
}

function readMainAsset(dir: string, ext: "js" | "css"): string {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const match = new RegExp(`\\./(entry-main-[0-9a-f]+\\.${ext})`).exec(html);
  if (!match?.[1]) throw new Error(`Missing hashed main.${ext} in ${dir}/index.html`);
  return match[1];
}

function startSwappableServer(initialRoot: string) {
  let activeRoot = initialRoot;
  const requests: { path: string; search: string; status: number }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (rel.endsWith("/")) rel += "index.html";
      const baseHeaders: Record<string, string> = {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      };
      if (rel.endsWith(".wasm")) {
        const res = await serveWasm(join(activeRoot, rel), req.headers.get("accept-encoding"), baseHeaders);
        requests.push({ path: url.pathname, search: url.search, status: res.status });
        return res;
      }
      const file = Bun.file(join(activeRoot, rel));
      if (!await file.exists()) {
        requests.push({ path: url.pathname, search: url.search, status: 404 });
        return new Response("not found", { status: 404, headers: { ...baseHeaders, "cache-control": "no-store" } });
      }
      const cacheControl = /(?:^|\/)(?:index\.html|sw\.js)$/.test(rel)
        ? "no-store"
        : /^\/(?:playground\/)?(?:__bunwasm\/)?(?:entry-|chunks\/.*\.js$)/.test(url.pathname)
          ? "public, max-age=31536000, immutable"
          : rel.endsWith(".js") || rel.endsWith(".css")
            // Deliberately aggressive caching for unhashed URLs so any accidental reference to
            // unhashed worker.js/main.js would reuse Build A's stale script after swap.
            ? "public, max-age=3600"
            : "no-cache";
      requests.push({ path: url.pathname, search: url.search, status: 200 });
      return new Response(file, { headers: { ...baseHeaders, "cache-control": cacheControl } });
    },
  });
  return {
    url: server.url.href,
    requests,
    swap(nextRoot: string) { activeRoot = nextRoot; },
    stop() { return server.stop(true); },
  };
}

async function serveWasm(path: string, acceptEncoding: string | null, base: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { ...base, vary: "Accept-Encoding" };
  const preference = acceptedEncodings(acceptEncoding) ?? ["identity"];
  const variants = [
    { encoding: "br", suffix: ".br" },
    { encoding: "gzip", suffix: ".gz" },
    { encoding: "identity", suffix: "" },
  ] as const;
  const available = new Map<string, ReturnType<typeof Bun.file>>();
  for (const { encoding, suffix } of variants) {
    const file = Bun.file(path + suffix);
    if (await file.exists()) available.set(encoding, file);
  }
  const fallback = available.get("identity") ?? available.get("gzip") ?? available.get("br");
  if (!fallback) return new Response("not found", { status: 404, headers: { ...headers, "cache-control": "no-store" } });
  headers["content-type"] = "application/wasm";
  for (const encoding of preference) {
    const file = available.get(encoding);
    if (file) {
      if (encoding !== "identity") headers["content-encoding"] = encoding;
      return new Response(file, { headers });
    }
    if (encoding === "identity") {
      const bytes = new Uint8Array(await fallback.arrayBuffer());
      const decoded = available.has("gzip") ? Bun.gunzipSync(bytes) : brotliDecompressSync(bytes);
      return new Response(decoded, { headers });
    }
  }
  return new Response(null, { status: 406, headers: { ...headers, "cache-control": "no-store" } });
}

function isRecoveredPreview502Console(message: ConsoleMessage): boolean {
  return /Failed to load resource:.*502/.test(message.text());
}

async function waitForSandboxReady(page: Page, phase: string): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const status = document.querySelector<HTMLElement>("#status");
      if (status?.dataset.kind === "error") {
        const term = document.querySelector<HTMLElement>("#terminal")?.textContent?.slice(-1500) ?? "";
        throw new Error(`Sandbox error: ${status.textContent}\nTerminal:\n${term}`);
      }
      const dot = document.querySelector("#server-dot")?.getAttribute("data-state");
      const frame = document.querySelector<HTMLIFrameElement>("#preview");
      const btn = frame?.contentDocument?.querySelector<HTMLButtonElement>("button.counter:not([disabled])");
      return status?.dataset.kind === "ok" && /dev server ready/.test(status.textContent ?? "") && dot === "up" && Boolean(btn);
    }, undefined, { timeout: STARTUP_MS });
  } catch (error) {
    const state = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#preview");
      return {
        status: document.querySelector<HTMLElement>("#status")?.textContent,
        statusKind: document.querySelector<HTMLElement>("#status")?.dataset.kind,
        serverState: document.querySelector("#server-dot")?.getAttribute("data-state"),
        previewUrl: document.querySelector<HTMLElement>("#preview-url")?.textContent,
        frameSrc: frame?.src,
        frameDocUrl: frame?.contentDocument?.URL,
        frameReadyState: frame?.contentDocument?.readyState,
        frameText: frame?.contentDocument?.body?.textContent?.slice(0, 500),
        terminalTail: document.querySelector<HTMLElement>("#terminal")?.textContent?.slice(-1000),
      };
    }).catch(() => null);
    throw new Error(`${phase} readiness failed: ${error instanceof Error ? error.message : String(error)}\nState: ${JSON.stringify(state, null, 2)}`, { cause: error });
  }
  const counter = page.frameLocator("#preview").locator("button.counter:not([disabled])");
  expect(await counter.textContent({ timeout: STARTUP_MS })).toContain("count is 0");
  await counter.click({ timeout: STARTUP_MS });
  expect(await counter.textContent({ timeout: STARTUP_MS })).toContain("count is 1");
}

async function waitForPlaygroundReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector<HTMLElement>("#status");
    if (status?.dataset.kind === "error") throw new Error(`Playground error: ${status.textContent}`);
    return status?.dataset.kind === "ok" && /ready/.test(status.textContent ?? "");
  }, undefined, { timeout: STARTUP_MS });
}

for (const browserName of browsers) {
  test(`${browserName}: reloading persistent / and /playground/ across a deploy with new entry, worker, SW and chunk hashes succeeds with zero 404s`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const localSite = process.env.BUN_WASM_DEPLOY_UPGRADE_SITE_DIR;
    if (process.env.CI && (!provided || localSite)) throw new Error("CI must provide the existing browser-guest site");
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `bun-wasm-upgrade-${browserName}-`));
    const siteDir = provided ? resolve(provided) : join(scratch, "site-bundle");
    const profileDir = join(scratch, "profile");
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof startSwappableServer> | undefined;
    try {
      const before = localSite ? undefined : provided ? verifySite(siteDir) : buildSite(siteDir);
      const sourceRoot = localSite ? resolve(localSite) : join(siteDir, "site");
      const buildA = join(scratch, "build-a");
      const buildB = join(scratch, "build-b");
      // Assemble production layout: sandbox at /, playground at /playground/.
      cpSync(join(sourceRoot, "sandbox"), buildA, { recursive: true });
      cpSync(sourceRoot, join(buildA, "playground"), { recursive: true, filter: src => !src.endsWith("/sandbox") });

      const sandboxRotated = await rotateAppBuild(buildA, buildB, resolve(import.meta.dir, "../sandbox/index.html"));
      const playgroundRotated = await rotateAppBuild(join(buildA, "playground"), join(buildB, "playground"), resolve(import.meta.dir, "../web/index.html"));
      expect(sandboxRotated.buildBEntries["worker.js"]).not.toBe(sandboxRotated.buildAEntries["worker.js"]);
      expect(sandboxRotated.buildBSwVersion).not.toBe(sandboxRotated.buildASwVersion);
      expect(playgroundRotated.buildBEntries["worker.js"]).not.toBe(playgroundRotated.buildAEntries["worker.js"]);

      server = startSwappableServer(buildA);
      const engine = { chromium, firefox, webkit }[browserName];
      if (!engine) throw new Error(`Unsupported browser ${browserName}`);
      context = await engine.launchPersistentContext(profileDir, { headless: true });
      const page = context.pages()[0] ?? await context.newPage();
      const errors: string[] = [];
      const browser404s: string[] = [];
      const browserResponses: { path: string; search: string; status: number }[] = [];
      page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
      page.on("response", response => {
        const parsed = new URL(response.url());
        if (parsed.origin !== new URL(server!.url).origin) return;
        browserResponses.push({ path: parsed.pathname, search: parsed.search, status: response.status() });
        if (response.status() === 404 && !parsed.pathname.includes("/__preview/")) browser404s.push(response.url());
        if (response.status() >= 500 && !parsed.pathname.includes("/__preview/")) errors.push(`http ${response.status()}: ${response.url()}`);
      });
      page.on("console", message => {
        if (message.type() === "error" && !isRecoveredPreview502Console(message)) errors.push(`console: ${message.text()}`);
      });

      // Visit 1: Build A on `/` default persistent FS (no mode=memory), write flushed marker.
      const markerPath = "/home/user/app/.deploy-upgrade-marker";
      const marker = `upgrade-${browserName}-${crypto.randomUUID()}`;
      await page.goto(server.url, { timeout: STARTUP_MS });
      await waitForSandboxReady(page, "build-a");
      const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
      expect(databases).toContain("bun-wasm-sandbox-vite-react");
      await page.evaluate(async ({ path, text }) => {
        const api = (globalThis as unknown as { sandbox: { fs: { writeFile(p: string, data: string): Promise<void>; flush(p?: string): Promise<void> } } }).sandbox;
        await api.fs.writeFile(path, text);
        await api.fs.flush(path);
      }, { path: markerPath, text: marker });

      expect(server.requests.filter(entry => entry.status === 404)).toEqual([]);
      expect(browser404s).toEqual([]);
      expect(server.requests.some(entry => entry.path.endsWith(`/${sandboxRotated.buildAEntries["worker.js"]}`))).toBe(true);

      // Also visit `/playground/` on Build A and run a command so its entry, worker, SW, and
      // idle command-chunk preloads are primed in the browser cache before Build B deploys.
      await page.goto(new URL("playground/?engine=browser&prompt=off", server.url).href, { timeout: STARTUP_MS });
      await waitForPlaygroundReady(page);
      const pgA = await runPlaygroundCommand(page, "bun -e 'console.log(1)'", 60_000);
      expect(pgA.code).toBe(0);
      expect(pgA.output).toContain("1");
      await page.evaluate(() => new Promise<void>(resolve => {
        if ("requestIdleCallback" in globalThis) {
          (globalThis as unknown as { requestIdleCallback(cb: () => void): void }).requestIdleCallback(() => setTimeout(resolve, 250));
        } else {
          setTimeout(resolve, 250);
        }
      }));
      expect(server.requests.some(entry => entry.path === `/playground/${playgroundRotated.buildAEntries["main.js"]}`)).toBe(true);
      expect(server.requests.some(entry => entry.path.endsWith(`/${playgroundRotated.buildAEntries["worker.js"]}`))).toBe(true);

      // Deploy Build B (all Build A chunks, hashed entries, and sw.js hashes rotated).
      const beforeSwapIndex = server.requests.length;
      const beforeSwapBrowserIndex = browserResponses.length;
      server.swap(buildB);

      // Visit 2a: Reload `/playground/` on Build B, run a real bun command to exercise its hashed worker.
      await page.reload({ timeout: STARTUP_MS });
      await waitForPlaygroundReady(page);
      const playgroundOutput = await runPlaygroundCommand(page, "bun -e 'console.log(40 + 2)'", 60_000);
      expect(playgroundOutput.code).toBe(0);
      expect(playgroundOutput.output).toContain("42");

      const pgReloadRequests = server.requests.slice(beforeSwapIndex);
      expect(pgReloadRequests.some(entry => entry.path === `/playground/${playgroundRotated.buildBEntries["main.js"]}`)).toBe(true);
      expect(pgReloadRequests.some(entry => entry.path.endsWith(`/${playgroundRotated.buildBEntries["worker.js"]}`))).toBe(true);
      expect(pgReloadRequests.some(entry => entry.path.endsWith(`/${playgroundRotated.buildAEntries["worker.js"]}`))).toBe(false);
      expect(pgReloadRequests.some(entry => entry.path === "/playground/sw.js" && entry.search === `?v=${playgroundRotated.buildBSwVersion}`)).toBe(true);

      // Visit 2b: Return to `/` on Build B (same profile, HTTP cache, SW, and persistent IndexedDB).
      const beforeRootSwapIndex = server.requests.length;
      await page.goto(server.url, { timeout: STARTUP_MS });
      await waitForSandboxReady(page, "build-b-reload");

      const persisted = await page.evaluate(async (path: string) => {
        const api = (globalThis as unknown as { sandbox: { fs: { readFile(p: string): Promise<Uint8Array> } } }).sandbox;
        return new TextDecoder().decode(await api.fs.readFile(path));
      }, markerPath);
      expect(persisted).toBe(marker);

      const rootReloadRequests = server.requests.slice(beforeRootSwapIndex);
      for (const key of ["main.js", "main.css", "worker.js", "fs-worker.js"] as const) {
        expect(rootReloadRequests.some(entry => entry.path.endsWith(`/${sandboxRotated.buildBEntries[key]}`))).toBe(true);
        expect(rootReloadRequests.some(entry => entry.path.endsWith(`/${sandboxRotated.buildAEntries[key]}`))).toBe(false);
      }
      expect(rootReloadRequests.some(entry => entry.path === "/sw.js" && entry.search === `?v=${sandboxRotated.buildBSwVersion}`)).toBe(true);

      expect(server.requests.slice(beforeSwapIndex).filter(entry => entry.status === 404)).toEqual([]);
      expect(browserResponses.slice(beforeSwapBrowserIndex).filter(entry => entry.status === 404 && !entry.path.includes("/__preview/"))).toEqual([]);
      expect(browser404s).toEqual([]);
      expect(errors).toEqual([]);

      // Missing Build A chunks under both `/` and `/playground/` must return 404 with Cache-Control: no-store.
      for (const missingPath of [`chunks/${sandboxRotated.oldChunk}`, `playground/chunks/${playgroundRotated.oldChunk}`]) {
        const missingChunk = await fetch(new URL(missingPath, server.url));
        expect(missingChunk.status).toBe(404);
        expect(missingChunk.headers.get("cache-control")).toBe("no-store");
      }

      if (before) expect(verifySite(siteDir)).toEqual(before);
    } finally {
      await context?.close().catch(() => {});
      await server?.stop().catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
}
