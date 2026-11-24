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
  readonly tarballsServed: number;
  waitForTarball(minCount: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** Deterministic offline npm registry with 16 multi-file packages and an observable tarball signal. */
function startLocalRegistry(packageCount = 16): LocalRegistry {
  const packages = new Map<string, { meta: string; tgz: Uint8Array }>();
  const dependencies: Record<string, string> = {};
  let tarballsServed = 0;
  const waiters = new Set<{ minCount: number; resolve(): void }>();
  const notifyTarball = () => {
    for (const waiter of Array.from(waiters)) {
      if (tarballsServed >= waiter.minCount) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };
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
        notifyTarball();
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
    waitForTarball(minCount: number, timeoutMs = 30_000): Promise<void> {
      if (tarballsServed >= minCount) return Promise.resolve();
      return new Promise((resolvePromise, reject) => {
        const entry = { minCount, resolve: () => { clearTimeout(timer); resolvePromise(); } };
        const timer = setTimeout(() => {
          waiters.delete(entry);
          reject(new Error(`Expected at least ${minCount} served tarballs within ${timeoutMs} ms, observed ${tarballsServed}`));
        }, timeoutMs);
        waiters.add(entry);
      });
    },
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

async function readSandboxFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async filePath => {
    const sb = Reflect.get(globalThis, "sandbox");
    const bytes: Uint8Array | undefined = await sb.fs.readFile(filePath);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, path);
}

async function stressSandboxMidEdit(context: BrowserContext, sandboxOrigin: string): Promise<void> {
  const errors: string[] = [];
  let page = await context.newPage();
  attachCorruptionGuard(page, errors);
  const baseline = `BASELINE_EDIT_${crypto.randomUUID()}`;

  try {
    await navigateTestPage(page, `${sandboxOrigin}/?template=vanilla`);
    await waitForSandboxReady(page, STARTUP_MS);

    // Commit a pre-interruption baseline file that must survive every interrupted write cycle intact.
    await page.evaluate(async value => {
      const sb = Reflect.get(globalThis, "sandbox");
      await sb.fs.writeFile("/home/user/app/.baseline.txt", value);
      await sb.fs.flush("/home/user/app/.baseline.txt");
      await sb.fs.flush();
    }, baseline);

    // 5 consecutive hard interruptions (alternating reload and tab close+reopen) while rapid writes/flushes are in flight.
    const delays = [0, 15, 40, 80, 150];
    for (const [cycle, delayMs] of delays.entries()) {
      const queued = await page.evaluate(async cycle => {
        const sb = Reflect.get(globalThis, "sandbox");
        if (!sb?.fs) throw new Error("Missing window.sandbox.fs");
        // Confirm the worker is actively accepting writes before launching the un-awaited burst + flush.
        await sb.fs.writeFile(`/home/user/app/inflight-enter-${cycle}.txt`, `enter=${cycle}`);
        let launched = 0;
        for (let i = 0; i < 20; i++) {
          const path = `/home/user/app/stress-${cycle}-${i}.txt`;
          void sb.fs.writeFile(path, `cycle=${cycle} item=${i} payload=${"a".repeat(2048)}`).catch(() => {});
          if (i % 4 === 0) void sb.fs.flush(path).catch(() => {});
          launched++;
        }
        void sb.fs.flush().catch(() => {});
        return launched;
      }, cycle);
      expect(queued).toBe(20);
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
      expect(await readSandboxFile(page, "/home/user/app/.baseline.txt")).toBe(baseline);
      expect(errors).toEqual([]);
    }

    // Final clean flushed write + reload must persist intact alongside the pre-interruption baseline.
    const marker = `FINAL_EDIT_MARKER_${crypto.randomUUID()}`;
    await page.evaluate(async marker => {
      const sb = Reflect.get(globalThis, "sandbox");
      await sb.fs.writeFile("/home/user/app/.stress-final.txt", marker);
      await sb.fs.flush("/home/user/app/.stress-final.txt");
      await sb.fs.flush();
    }, marker);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSandboxReady(page, STARTUP_MS);
    expect(await readSandboxFile(page, "/home/user/app/.baseline.txt")).toBe(baseline);
    expect(await readSandboxFile(page, "/home/user/app/.stress-final.txt")).toBe(marker);
    expect(errors).toEqual([]);
  } finally {
    await page.close().catch(() => {});
  }
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

async function waitForPlaygroundReady(page: Page, contextLabel: string): Promise<void> {
  await page.waitForFunction(label => {
    const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
    const status = document.querySelector<HTMLElement>("#status");
    if (status?.dataset.kind === "error") throw new Error(`Playground error (${label}): ${status.textContent}`);
    return /ready/.test(status?.textContent ?? "") && Boolean(pg?.shell?.state === "ready" && !pg?.shell?.running);
  }, contextLabel, { timeout: STARTUP_MS });
}

async function readPlaygroundFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async filePath => {
    const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
    const bytes = await pg?.fs?.readFile(filePath);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, path);
}

async function stressPlaygroundMidInstall(context: BrowserContext, playgroundOrigin: string): Promise<void> {
  const errors: string[] = [];
  let interrupting = false;
  let registry: LocalRegistry | undefined;
  let page: Page | undefined;
  const targetUrl = `${playgroundOrigin}/?engine=browser&prompt=off`;
  const baseline = `BASELINE_INSTALL_${crypto.randomUUID()}`;

  const interruptPage = async (cycle: number): Promise<void> => {
    interrupting = true;
    try {
      if (cycle % 2 === 0) {
        await page!.reload({ waitUntil: "domcontentloaded" });
        return;
      }
      await page!.close();
      page = await context.newPage();
      attachCorruptionGuard(page, errors, () => interrupting);
      await navigateTestPage(page, targetUrl);
    } finally {
      interrupting = false;
    }
  };

  try {
    registry = startLocalRegistry(16);
    page = await context.newPage();
    attachCorruptionGuard(page, errors, () => interrupting);
    expect(await openPlaygroundPage(page, targetUrl)).toContain("ready");

    // Commit a pre-interruption baseline file that must survive every interrupted install cycle.
    await page.evaluate(async ({ base, dependencies, baseline }) => {
      const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
      if (!pg?.fs) throw new Error("Missing playground handle");
      await pg.fs.writeFile("/home/user/.baseline-install.txt", baseline);
      await pg.fs.writeFile("/home/user/package.json", JSON.stringify({ name: "stress-install", dependencies }));
      await pg.fs.writeFile("/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(base)}\n`);
      await pg.fs.flush();
    }, { base: registry.base, dependencies: registry.dependencies, baseline });

    // 4 consecutive hard interruptions mid-`bun install`, each waiting for an observed tarball download before killing the page.
    for (let cycle = 0; cycle < 4; cycle++) {
      const beforeTarballs = registry.tarballsServed;
      await page.evaluate(async ({ base, dependencies }) => {
        const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
        if (!pg?.fs || !pg?.shell) throw new Error("Missing playground handle");
        await pg.fs.writeFile("/home/user/package.json", JSON.stringify({ name: "stress-install", dependencies }));
        await pg.fs.writeFile("/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(base)}\n`);
        await pg.fs.flush();
        // Start install without awaiting; we interrupt as soon as tarballs are actively being downloaded/extracted.
        void pg.shell.submit("rm -rf node_modules bun.lock && bun install --no-cache").catch(() => {});
      }, { base: registry.base, dependencies: registry.dependencies });

      await registry.waitForTarball(beforeTarballs + Math.min(1 + cycle * 2, 8), 30_000);
      expect(registry.tarballsServed).toBeGreaterThan(beforeTarballs);
      await interruptPage(cycle);

      await waitForPlaygroundReady(page, `after interrupted install cycle ${cycle}`);
      expect(await readPlaygroundFile(page, "/home/user/.baseline-install.txt")).toBe(baseline);
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

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPlaygroundReady(page, "after clean install reload");

    expect(await readPlaygroundFile(page, "/home/user/.baseline-install.txt")).toBe(baseline);
    expect(await readPlaygroundFile(page, "/home/user/node_modules/stress-pkg-15/index.js")).toContain('tag = "stress-15"');
    expect(errors).toEqual([]);
  } finally {
    await page?.close().catch(() => {});
    await registry?.close();
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

  const errors: string[] = [];
  const dbsToDelete: string[] = [];
  let page: Page | undefined;

  try {
    const openHarness = async () => {
      const next = await context.newPage();
      attachCorruptionGuard(next, errors);
      await navigateTestPage(next, server.url.href);
      await next.waitForFunction(() => Boolean(Reflect.get(globalThis, "persistenceHarness")));
      return next;
    };

    // 4 deterministic OPFS native partial-write interruptions alternating payload and snapshot boundaries.
    for (const [cycle, boundary] of (["payload", "snapshot", "payload", "snapshot"] as const).entries()) {
      const db = `bunwasm-opfs-stress-${cycle}-${crypto.randomUUID()}`;
      dbsToDelete.push(db);
      page = await openHarness();
      const old = await page.evaluate(async dbName => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        await h.direct("open", { name: dbName, storage: "opfs" });
        return h.direct("seedInterrupted");
      }, db);

      // Start a real multi-megabyte OPFS commit and wait for Waffle's native partial-write boundary signal.
      await page.evaluate(b => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        void h.direct("interruptCommit", b).catch(() => {});
      }, boundary);
      await page.waitForFunction(() => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        return Boolean(h?.state?.commitStarted && h?.state?.partialWrite === true);
      }, undefined, { timeout: 30_000 });
      const observed = await page.evaluate(() => {
        const state = Reflect.get(globalThis, "persistenceHarness").state;
        return { boundary: state.boundary, partialWrite: state.partialWrite };
      });
      expect(observed).toEqual({ boundary, partialWrite: true });

      // Hard-close the page at the exact partial native write boundary.
      await page.close();
      page = await openHarness();
      const recovered = await page.evaluate(async dbName => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        await h.direct("open", { name: dbName, storage: "opfs" });
        const result = await h.direct("inspectInterrupted");
        await h.destroy();
        return result;
      }, db);
      expect(["old", "new"]).toContain(recovered.state);
      if (recovered.state === "old") expect(recovered.metadata).toEqual(old.metadata);
      expect(errors).toEqual([]);
      await page.close();
      page = undefined;
    }

    // Final clean OPFS write + flush + reload confirms persistent OPFS remains healthy and durable.
    const cleanDb = `bunwasm-opfs-final-${crypto.randomUUID()}`;
    dbsToDelete.push(cleanDb);
    const marker = `opfs-final-${crypto.randomUUID()}`;
    page = await openHarness();
    await page.evaluate(async ({ dbName, marker }) => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.open(dbName, true, "opfs");
      await h.write("/final.txt", Array.from(new TextEncoder().encode(marker)));
      await h.flush();
    }, { dbName: cleanDb, marker });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(Reflect.get(globalThis, "persistenceHarness")));
    const finalSnapshot: { path: string; bytes: number[] }[] = await page.evaluate(async dbName => {
      const h = Reflect.get(globalThis, "persistenceHarness");
      await h.open(dbName, true, "opfs");
      const snap = await h.snapshot();
      await h.destroy();
      return snap;
    }, cleanDb);
    const finalFile = finalSnapshot.find(entry => entry.path === "/final.txt");
    expect(finalFile).toBeDefined();
    expect(new TextDecoder().decode(Uint8Array.from(finalFile!.bytes))).toBe(marker);
    expect(errors).toEqual([]);
    for (const dbName of dbsToDelete) {
      await page.evaluate(name => Reflect.get(globalThis, "persistenceHarness").deleteDatabase(name, "opfs"), dbName).catch(() => {});
    }
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
  const stop = async () => {
    child.kill("SIGTERM");
    await child.exited.catch(() => {});
  };
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let output = "";
  let origin = "";
  try {
    while (!origin) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`serve.ts exited early: ${output}`);
      output += dec.decode(value, { stream: true });
      const match = /at (http:\/\/\S+) \(cross-origin isolated\)/.exec(output);
      if (match?.[1]) origin = match[1].replace(/\/$/, "");
    }
    reader.releaseLock();
    return { origin, stop };
  } catch (error) {
    reader.releaseLock();
    await stop();
    throw error;
  }
}

for (const browserName of browsers) {
  test(`${browserName}: repeated interrupted mid-edit and mid-install reloads never corrupt IndexedDB or OPFS`, async () => {
    const engine = { chromium, firefox, webkit }[browserName];
    if (!engine) throw new Error(`Unknown browser: ${browserName}`);

    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must supply BUN_WASM_BROWSER_SITE");
    const scratch = mkdtempSync(join(tmpdir(), `bun-wasm-interrupted-persist-${browserName}-`));
    const siteDir = provided ? resolve(provided) : join(scratch, "site-build");
    let sandboxServer: { origin: string; stop(): Promise<void> } | undefined;
    let playgroundServer: { origin: string; stop(): Promise<void> } | undefined;
    let context: BrowserContext | undefined;

    try {
      const before = provided ? verifySite(siteDir) : buildSite(siteDir);
      const sandboxRoot = join(siteDir, "site/sandbox");
      const playgroundRoot = join(siteDir, "site");
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
