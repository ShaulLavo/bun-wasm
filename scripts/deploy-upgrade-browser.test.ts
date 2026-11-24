import { expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { chromium, firefox, webkit, type BrowserContext, type ConsoleMessage, type Page } from "playwright";
import { acceptedEncodings } from "./accept-encoding";
import { buildSite, verifySite } from "./browser-guest-site";
import { publishVersionedEntries, rewriteEntryHtml, VERSIONED_WORKER_FILES } from "./browser-build";

// Real browser install/dev + reload across two builds; timeout only catches a hang.
setDefaultTimeout(300_000);

const STARTUP_MS = 180_000;
const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");

/**
 * Produces Build B from a copy of Build A by rotating every chunk filename under chunks/ and
 * __bunwasm/chunks/, rewriting imports inside all built JS files, and regenerating all content-
 * hashed `entry-*` files and `index.html`. Every Build A chunk and hashed entry URL 404s in B.
 */
async function rotateBuild(buildA: string, buildB: string): Promise<{ oldChunk: string; buildAEntries: Record<string, string>; buildBEntries: Record<string, string> }> {
  cpSync(buildA, buildB, { recursive: true });
  const buildAEntries = readEmbeddedAssets(buildA);
  const chunkDir = join(buildB, "chunks");
  const chunkFiles = readdirSync(chunkDir).filter(name => name.endsWith(".js")).sort();
  if (!chunkFiles.length) throw new Error("Sandbox build has no JS chunks to rotate");

  const renames = new Map<string, string>();
  for (const name of chunkFiles) {
    const rotated = name.replace(/\.js$/, "-b2.js");
    renames.set(name, rotated);
    for (const dir of [chunkDir, join(buildB, "__bunwasm/chunks")]) {
      const source = join(dir, name);
      if (await Bun.file(source).exists()) {
        const bytes = await Bun.file(source).bytes();
        await Bun.write(join(dir, rotated), bytes);
        rmSync(source, { force: true });
      }
    }
  }

  // Remove Build A's hashed entries before rewriting plain entries and re-emitting Build B's.
  for (const dir of [buildB, join(buildB, "__bunwasm")]) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("entry-")) rmSync(join(dir, name), { force: true });
    }
  }

  const jsDirs = [buildB, join(buildB, "chunks"), join(buildB, "__bunwasm"), join(buildB, "__bunwasm/chunks")];
  for (const dir of jsDirs) rewriteChunkReferences(dir, renames);

  // Also vary main.css slightly so main.css gets a fresh hash in Build B too.
  writeFileSync(join(buildB, "main.css"), `${readFileSync(join(buildB, "main.css"), "utf8")}\n/* build-b */\n`);

  const entries = await publishVersionedEntries(buildB);
  const workerAssets = Object.fromEntries(VERSIONED_WORKER_FILES.map(name => [name, entries[name]!]));
  const builds = JSON.parse(readFileSync(join(buildB, "engine-builds.json"), "utf8")) as Record<string, string>;
  const templateHtml = readFileSync(resolve(import.meta.dir, "../sandbox/index.html"), "utf8");
  const index = rewriteEntryHtml(templateHtml, entries).replace(
    "<head>",
    `<head><script>globalThis.__bunwasmBuilds=${JSON.stringify(builds)};globalThis.__bunwasmAssets=${JSON.stringify(workerAssets)}</script>`,
  );
  writeFileSync(join(buildB, "index.html"), index);

  return { oldChunk: chunkFiles[0]!, buildAEntries, buildBEntries: workerAssets };
}

function readEmbeddedAssets(dir: string): Record<string, string> {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const match = /globalThis\.__bunwasmAssets=(\{[^;]*?\})(?:;|<\/script>)/.exec(html);
  if (!match?.[1]) throw new Error(`Missing embedded __bunwasmAssets in ${dir}/index.html`);
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
function startSwappableServer(initialRoot: string) {
  let activeRoot = initialRoot;
  const requests: { path: string; status: number }[] = [];
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
        requests.push({ path: url.pathname, status: res.status });
        return res;
      }
      const file = Bun.file(join(activeRoot, rel));
      if (!await file.exists()) {
        requests.push({ path: url.pathname, status: 404 });
        return new Response("not found", { status: 404, headers: { ...baseHeaders, "cache-control": "no-store" } });
      }
      const cacheControl = rel === "/index.html" || rel === "/sw.js"
        ? "no-store"
        : /^\/(?:__bunwasm\/)?(?:entry-|chunks\/.*\.js$)/.test(url.pathname)
          ? "public, max-age=31536000, immutable"
          : rel.endsWith(".js") || rel.endsWith(".css")
            // Deliberately aggressive caching for unhashed URLs so any accidental reference to
            // unhashed worker.js/main.js would reuse Build A's stale script after swap.
            ? "public, max-age=3600"
            : "no-cache";
      requests.push({ path: url.pathname, status: 200 });
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

for (const browserName of browsers) {
  test(`${browserName}: reloading a persistent sandbox across a deploy with new worker and chunk hashes succeeds with zero 404s`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const localSandbox = process.env.BUN_WASM_DEPLOY_UPGRADE_SANDBOX_DIR;
    if (process.env.CI && (!provided || localSandbox)) throw new Error("CI must provide the existing browser-guest site");
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `bun-wasm-upgrade-${browserName}-`));
    const siteDir = provided ? resolve(provided) : join(scratch, "site-bundle");
    const profileDir = join(scratch, "profile");
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof startSwappableServer> | undefined;
    try {
      const before = localSandbox ? undefined : provided ? verifySite(siteDir) : buildSite(siteDir);
      const buildA = join(scratch, "build-a");
      const buildB = join(scratch, "build-b");
      cpSync(localSandbox ? resolve(localSandbox) : join(siteDir, "site/sandbox"), buildA, { recursive: true });
      const { oldChunk, buildAEntries, buildBEntries } = await rotateBuild(buildA, buildB);
      expect(buildBEntries["worker.js"]).not.toBe(buildAEntries["worker.js"]);

      server = startSwappableServer(buildA);
      const engine = { chromium, firefox, webkit }[browserName];
      if (!engine) throw new Error(`Unsupported browser ${browserName}`);
      context = await engine.launchPersistentContext(profileDir, { headless: true });
      const page = context.pages()[0] ?? await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
      page.on("response", response => {
        if (response.status() >= 500 && !response.url().includes("/__preview/")) errors.push(`http ${response.status()}: ${response.url()}`);
      });
      page.on("console", message => {
        if (message.type() === "error" && !isRecoveredPreview502Console(message)) errors.push(`console: ${message.text()}`);
      });

      // Visit 1: Build A on default persistent FS (no mode=memory).
      await page.goto(server.url, { timeout: STARTUP_MS });
      await waitForSandboxReady(page, "build-a");
      const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
      expect(databases).toContain("bun-wasm-sandbox-vite-react");
      await page.evaluate(async () => { await (globalThis as unknown as { sandbox: { fs: { flush(): Promise<void> } } }).sandbox.fs.flush(); });

      const buildA404s = server.requests.filter(entry => entry.status === 404);
      expect(buildA404s).toEqual([]);
      expect(server.requests.some(entry => entry.path.endsWith(`/${buildAEntries["worker.js"]}`))).toBe(true);

      // Deploy Build B (all Build A chunks and entry-* now 404).
      const beforeSwapIndex = server.requests.length;
      server.swap(buildB);

      // Visit 2: Full reload on the SAME profile, HTTP cache, Service Worker, and persistent IndexedDB.
      await page.reload({ timeout: STARTUP_MS });
      await waitForSandboxReady(page, "build-b-reload");

      const reloadRequests = server.requests.slice(beforeSwapIndex);
      expect(reloadRequests.filter(entry => entry.status === 404)).toEqual([]);
      expect(reloadRequests.some(entry => entry.path.endsWith(`/${buildBEntries["worker.js"]}`))).toBe(true);
      expect(reloadRequests.some(entry => entry.path.endsWith(`/${buildAEntries["worker.js"]}`))).toBe(false);
      expect(errors).toEqual([]);

      // Missing Build A chunks must return 404 with Cache-Control: no-store (never immutable).
      const missingChunk = await fetch(new URL(`chunks/${oldChunk}`, server.url));
      expect(missingChunk.status).toBe(404);
      expect(missingChunk.headers.get("cache-control")).toBe("no-store");

      if (before) expect(verifySite(siteDir)).toEqual(before);
    } finally {
      await context?.close().catch(() => {});
      await server?.stop().catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
}
