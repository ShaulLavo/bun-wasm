import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "playwright";
import { browserBuildConfig } from "./browser-build";
import { buildSite, verifySite } from "./browser-guest-site";
import { openPlaygroundPage } from "../web/tests/playground-navigation";
import { navigateTestPage } from "../web/tests/navigate-test-page";

// Real browser persistent-VFS crash/reload stress across IndexedDB and OPFS; timeout only catches a hang.
setDefaultTimeout(360_000);

const STARTUP_MS = 180_000;
const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");

function tarEntry(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode("0000644\0"), 100);
  header.set(enc.encode("0000000\0"), 108);
  header.set(enc.encode("0000000\0"), 116);
  header.set(enc.encode(content.byteLength.toString(8).padStart(11, "0") + "\0"), 124);
  header.set(enc.encode("00000000000\0"), 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // '0' regular file
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  header.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padded = Math.ceil(content.byteLength / 512) * 512;
  const out = new Uint8Array(512 + padded);
  out.set(header, 0);
  out.set(content, 512);
  return out;
}

function makeTarGz(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const blocks = Object.entries(files).map(([name, text]) => tarEntry(`package/${name}`, enc.encode(text)));
  const total = blocks.reduce((acc, b) => acc + b.byteLength, 0) + 1024;
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return Bun.gzipSync(tar);
}

interface LocalRegistry {
  base: string;
  dependencies: Record<string, string>;
  tarballsServed: number;
  close(): Promise<void>;
}

/** Deterministic offline npm registry with 16 multi-file packages so `bun install` performs sustained VFS writes. */
function startLocalRegistry(packageCount = 16): LocalRegistry {
  const packages = new Map<string, { meta: string; tgz: Uint8Array }>();
  const dependencies: Record<string, string> = {};
  let tarballsServed = 0;
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "no-store",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/+/, "");
      if (path.endsWith(".tgz")) {
        const name = path.slice(0, -4);
        const entry = packages.get(name);
        if (!entry) return new Response("not found", { status: 404, headers: corsHeaders });
        tarballsServed++;
        return new Response(new Uint8Array(entry.tgz), {
          headers: { ...corsHeaders, "content-type": "application/gzip" },
        });
      }
      const entry = packages.get(path);
      if (!entry) return new Response("not found", { status: 404, headers: corsHeaders });
      return new Response(entry.meta, {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    },
  });
  const base = server.url.href.replace(/\/$/, "");
  for (let i = 0; i < packageCount; i++) {
    const name = `stress-pkg-${i}`;
    dependencies[name] = "1.0.0";
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      "index.js": `export const id = ${i}; export const tag = "stress-${i}";\n`,
    };
    for (let f = 0; f < 10; f++) {
      files[`chunk-${f}.js`] = `export const v = "${name}-${f}-${"x".repeat(512)}";\n`;
    }
    const tgz = makeTarGz(files);
    const shasum = new Bun.CryptoHasher("sha1").update(tgz).digest("hex");
    const integrity = `sha512-${Buffer.from(new Bun.CryptoHasher("sha512").update(tgz).digest()).toString("base64")}`;
    const meta = JSON.stringify({
      name,
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name,
          version: "1.0.0",
          dist: { tarball: `${base}/${name}.tgz`, shasum, integrity },
        },
      },
    });
    packages.set(name, { meta, tgz });
  }
  return {
    base,
    dependencies,
    get tarballsServed() { return tarballsServed; },
    async close() { await server.stop(true); },
  };
}

function attachCorruptionGuard(page: Page, errors: string[], isInterrupting?: () => boolean): void {
  page.on("pageerror", error => {
    const message = error.message;
    // WebKit surfaces aborted cross-origin fetches during intentional reload/close as access-control pageerrors.
    if (isInterrupting?.() && /due to access control checks|cancelled|aborted|Load failed/i.test(message)) return;
    errors.push(`pageerror: ${message}`);
  });
  page.on("console", message => {
    const text = message.text();
    if (/INVALID_VFS_FORMAT|saved workspace unreadable|corrupt/i.test(text)) {
      errors.push(`console(${message.type()}): ${text}`);
    }
  });
}

async function waitForSandboxReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector<HTMLElement>("#status");
    if (status?.dataset.kind === "error") throw new Error(`Sandbox error: ${status.textContent}`);
    const dot = document.querySelector("#server-dot")?.getAttribute("data-state");
    const frame = document.querySelector<HTMLIFrameElement>("#preview");
    let button: Element | null = null;
    try { button = frame?.contentDocument?.querySelector("button.counter:not([disabled])") ?? null; }
    catch { button = null; }
    return status?.dataset.kind === "ok" && /dev server ready/.test(status.textContent ?? "") && dot === "up" && Boolean(button);
  }, undefined, { timeout: timeoutMs });
}

async function stressSandboxMidEdit(context: BrowserContext, sandboxOrigin: string): Promise<void> {
  const errors: string[] = [];
  let page = await context.newPage();
  attachCorruptionGuard(page, errors);
  await navigateTestPage(page, `${sandboxOrigin}/?template=vanilla`);
  await waitForSandboxReady(page, STARTUP_MS);

  // 5 consecutive hard interruptions (alternating reload and tab close+reopen) during rapid un-flushed writes.
  const delays = [0, 15, 40, 80, 150];
  for (const [cycle, delayMs] of delays.entries()) {
    await page.evaluate(cycle => {
      const sb = Reflect.get(globalThis, "sandbox");
      if (!sb?.fs) throw new Error("Missing window.sandbox.fs");
      // Fire rapid overlapping writes + background flushes without awaiting completion before interruption.
      for (let i = 0; i < 20; i++) {
        const path = `/home/user/app/stress-${cycle}-${i}.txt`;
        void sb.fs.writeFile(path, `cycle=${cycle} item=${i} payload=${"a".repeat(2048)}`).catch(() => {});
        if (i % 4 === 0) void sb.fs.flush(path).catch(() => {});
      }
      void sb.fs.flush().catch(() => {});
    }, cycle);
    if (delayMs > 0) await page.waitForTimeout(delayMs);

    if (cycle % 2 === 0) {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.close();
      page = await context.newPage();
      attachCorruptionGuard(page, errors);
      await navigateTestPage(page, `${sandboxOrigin}/?template=vanilla`);
    }
    await waitForSandboxReady(page, STARTUP_MS);
    expect(errors).toEqual([]);
  }

  // Final clean flushed write + reload must persist intact.
  const marker = `FINAL_EDIT_MARKER_${crypto.randomUUID()}`;
  await page.evaluate(async marker => {
    const sb = Reflect.get(globalThis, "sandbox");
    await sb.fs.writeFile("/home/user/app/.stress-final.txt", marker);
    await sb.fs.flush("/home/user/app/.stress-final.txt");
    await sb.fs.flush();
  }, marker);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSandboxReady(page, STARTUP_MS);
  const readBack = await page.evaluate(async () => {
    const sb = Reflect.get(globalThis, "sandbox");
    const bytes: Uint8Array | undefined = await sb.fs.readFile("/home/user/app/.stress-final.txt");
    return bytes ? new TextDecoder().decode(bytes) : null;
  });
  expect(readBack).toBe(marker);
  expect(errors).toEqual([]);
  await page.close();
}

interface PlaygroundHandle {
  fs?: {
    writeFile(path: string, data: string): Promise<void>;
    readFile(path: string): Promise<Uint8Array | undefined>;
    flush(path?: string): Promise<void>;
  };
  shell?: {
    state?: string;
    running?: boolean;
    lastExit?: number;
    submit(command: string): Promise<void>;
  };
}

function assertOpfsSnapshot(snapshot: { path: string; bytes: number[] }[]): void {
  const seed = snapshot.find(entry => entry.path === "/seed.txt");
  expect(seed).toBeDefined();
  expect(new TextDecoder().decode(Uint8Array.from(seed!.bytes))).toBe("seed-v0");
  for (const entry of snapshot) {
    if (!entry.path.startsWith("/burst-")) continue;
    const decoded = new TextDecoder().decode(Uint8Array.from(entry.bytes));
    expect(decoded).toMatch(/^gen=\d+;idx=\d+;z{1024}$/);
  }
}

async function stressPlaygroundMidInstall(context: BrowserContext, playgroundOrigin: string): Promise<void> {
  const registry = startLocalRegistry(16);
  const errors: string[] = [];
  let interrupting = false;
  let page = await context.newPage();
  attachCorruptionGuard(page, errors, () => interrupting);
  const targetUrl = `${playgroundOrigin}/?engine=browser&prompt=off`;

  const interruptPage = async (cycle: number): Promise<void> => {
    interrupting = true;
    try {
      if (cycle % 2 === 0) {
        await page.reload({ waitUntil: "domcontentloaded" });
        return;
      }
      await page.close();
      page = await context.newPage();
      attachCorruptionGuard(page, errors, () => interrupting);
      await navigateTestPage(page, targetUrl);
    } finally {
      interrupting = false;
    }
  };

  try {
    expect(await openPlaygroundPage(page, targetUrl)).toContain("ready");

    // 4 consecutive hard interruptions mid-`bun install` against the local multi-package tarball registry.
    const delays = [150, 350, 550, 750];
    for (const [cycle, delayMs] of delays.entries()) {
      await page.evaluate(async ({ base, dependencies }) => {
        const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
        if (!pg?.fs || !pg?.shell) throw new Error("Missing playground handle");
        await pg.fs.writeFile("/home/user/package.json", JSON.stringify({ name: "stress-install", dependencies }));
        await pg.fs.writeFile("/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(base)}\n`);
        await pg.fs.flush();
        // Start install without awaiting; we intentionally kill/reload the page mid-install.
        void pg.shell.submit("rm -rf node_modules bun.lock && bun install --no-cache").catch(() => {});
      }, { base: registry.base, dependencies: registry.dependencies });

      await page.waitForTimeout(delayMs);
      await interruptPage(cycle);

      await page.waitForFunction(() => {
        const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
        const status = document.querySelector<HTMLElement>("#status");
        if (status?.dataset.kind === "error") throw new Error(`Playground error after interrupted install: ${status.textContent}`);
        return /ready/.test(status?.textContent ?? "") && Boolean(pg?.shell?.state === "ready" && !pg?.shell?.running);
      }, undefined, { timeout: STARTUP_MS });
      expect(errors).toEqual([]);
    }

    // Final clean install must exit 0, flush, and survive reload on the same persistent workspace.
    const finalExit = await page.evaluate(async ({ base, dependencies }) => {
      const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
      if (!pg?.fs || !pg?.shell) throw new Error("Missing playground handle");
      await pg.fs.writeFile("/home/user/package.json", JSON.stringify({ name: "stress-install", dependencies }));
      await pg.fs.writeFile("/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(base)}\n`);
      await pg.shell.submit("bun install");
      await pg.fs.flush();
      return pg.shell.lastExit;
    }, { base: registry.base, dependencies: registry.dependencies });
    expect(finalExit).toBe(0);
    expect(registry.tarballsServed).toBeGreaterThan(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
      const status = document.querySelector<HTMLElement>("#status");
      if (status?.dataset.kind === "error") throw new Error(`Playground error after reload: ${status.textContent}`);
      return /ready/.test(status?.textContent ?? "") && Boolean(pg?.shell?.state === "ready" && !pg?.shell?.running);
    }, undefined, { timeout: STARTUP_MS });

    const persisted = await page.evaluate(async () => {
      const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
      const bytes = await pg?.fs?.readFile("/home/user/node_modules/stress-pkg-15/index.js");
      return bytes ? new TextDecoder().decode(bytes) : null;
    });
    expect(persisted).toContain('tag = "stress-15"');
    expect(errors).toEqual([]);
  } finally {
    await page.close().catch(() => {});
    await registry.close();
  }
}

async function stressOpfsMidWrite(context: BrowserContext, scratchDir: string): Promise<void> {
  const out = join(scratchDir, "opfs-dist");
  const built = await Bun.build(browserBuildConfig([
    resolve(import.meta.dir, "../web/tests/persistence-browser-main.ts"),
    resolve(import.meta.dir, "../web/src/fs-worker.ts"),
    resolve(import.meta.dir, "../web/tests/persistence-browser-worker.ts"),
  ], out));
  expect(built.success, built.logs.map(String).join("\n")).toBe(true);
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./persistence-browser-main.js"></script>');

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(out + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404 });
      return new Response(Bun.file(file), {
        headers: { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" },
      });
    },
  });

  const dbName = `bunwasm-opfs-stress-${crypto.randomUUID()}`;
  const errors: string[] = [];
  let page: Page | undefined;

  try {
    const openHarness = async () => {
      const next = await context.newPage();
      attachCorruptionGuard(next, errors);
      await navigateTestPage(next, server.url.href);
      await next.waitForFunction(() => Boolean(Reflect.get(globalThis, "persistenceHarness")));
      return next;
    };

    // Seed initial baseline generation on OPFS.
    page = await openHarness();
    await page.evaluate(async dbName => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.open(dbName, true, "opfs");
      await h.write("/seed.txt", Array.from(new TextEncoder().encode("seed-v0")));
      await h.flush();
    }, dbName);

    // 5 consecutive hard tab closes during rapid OPFS write + flush bursts.
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.evaluate(cycle => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        const enc = new TextEncoder();
        for (let i = 0; i < 25; i++) {
          void h.write(`/burst-${cycle}-${i}.bin`, Array.from(enc.encode(`gen=${cycle};idx=${i};${"z".repeat(1024)}`))).catch(() => {});
          if (i % 5 === 0) void h.flush().catch(() => {});
        }
        void h.flush().catch(() => {});
      }, cycle);
      await page.waitForTimeout(cycle * 25);
      // Hard-close the page mid-write without graceful dispose.
      await page.close();

      page = await openHarness();
      const snapshot: { path: string; bytes: number[] }[] = await page.evaluate(async dbName => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        await h.open(dbName, true, "opfs");
        return h.snapshot();
      }, dbName);
      assertOpfsSnapshot(snapshot);
      expect(errors).toEqual([]);
    }

    // Final clean write + flush + reload verifies OPFS remains writable and durable after repeated hard closes.
    const marker = `opfs-final-${crypto.randomUUID()}`;
    await page.evaluate(async marker => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.write("/final.txt", Array.from(new TextEncoder().encode(marker)));
      await h.flush();
    }, marker);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(Reflect.get(globalThis, "persistenceHarness")));
    const finalSnapshot: { path: string; bytes: number[] }[] = await page.evaluate(async dbName => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.open(dbName, true, "opfs");
      return h.snapshot();
    }, dbName);
    const finalFile = finalSnapshot.find(entry => entry.path === "/final.txt");
    expect(finalFile).toBeDefined();
    expect(new TextDecoder().decode(Uint8Array.from(finalFile!.bytes))).toBe(marker);
    expect(errors).toEqual([]);
    await page.evaluate(async dbName => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.destroy();
      await h.deleteDatabase(dbName, "opfs");
    }, dbName).catch(() => {});
  } finally {
    await page?.close().catch(() => {});
    await server.stop(true);
  }
}

async function startServeProcess(root: string): Promise<{ origin: string; stop(): Promise<void> }> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../web/serve.ts")], {
    env: { ...process.env, ROOT: root, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let output = "";
  let origin = "";
  while (!origin) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`serve.ts exited early: ${output}`);
    output += dec.decode(value, { stream: true });
    const match = /at (http:\/\/\S+) \(cross-origin isolated\)/.exec(output);
    if (match?.[1]) origin = match[1].replace(/\/$/, "");
  }
  reader.releaseLock();
  return {
    origin,
    async stop() {
      child.kill("SIGTERM");
      await child.exited.catch(() => {});
    },
  };
}

for (const browserName of browsers) {
  test(`${browserName}: repeated interrupted mid-edit and mid-install reloads never corrupt IndexedDB or OPFS`, async () => {
    const engine = { chromium, firefox, webkit }[browserName];
    if (!engine) throw new Error(`Unknown browser: ${browserName}`);

    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must supply BUN_WASM_BROWSER_SITE");
    const scratch = mkdtempSync(join(tmpdir(), `bun-wasm-interrupted-persist-${browserName}-`));
    const siteDir = provided ? resolve(provided) : join(scratch, "site-build");
    const before = provided ? verifySite(siteDir) : buildSite(siteDir);
    const sandboxRoot = join(siteDir, "site/sandbox");
    const playgroundRoot = join(siteDir, "site");
    let sandboxServer: { origin: string; stop(): Promise<void> } | undefined;
    let playgroundServer: { origin: string; stop(): Promise<void> } | undefined;
    let context: BrowserContext | undefined;

    try {
      sandboxServer = await startServeProcess(sandboxRoot);
      playgroundServer = await startServeProcess(playgroundRoot);
      // Persistent profile is required for real on-disk IndexedDB + WebKit OPFS across reloads/closes.
      context = await engine.launchPersistentContext(join(scratch, "profile"), { headless: true });

      await stressSandboxMidEdit(context, sandboxServer.origin);
      await stressPlaygroundMidInstall(context, playgroundServer.origin);
      await stressOpfsMidWrite(context, scratch);

      expect(verifySite(siteDir)).toEqual(before);
    } finally {
      await context?.close().catch(() => {});
      await sandboxServer?.stop();
      await playgroundServer?.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
