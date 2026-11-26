import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "playwright";
import { browserBuildConfig } from "./browser-build";
import { buildSite, verifySite } from "./browser-guest-site";
import { openPlaygroundPage } from "../web/tests/playground-navigation";
import { navigateTestPage } from "../web/tests/navigate-test-page";
import { isCancelledLoadingStatusPoll } from "./preview-loading-noise";

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
  readonly tarballsCompleted: number;
  readonly heldCount: number;
  holdAfter(position: number | null): void;
  waitForHeld(timeoutMs?: number): Promise<void>;
  releaseHeld(): void;
  close(): Promise<void>;
}

function closeHeldStream(controller: ReadableStreamDefaultController<Uint8Array>, tail: Uint8Array): void {
  try {
    controller.enqueue(tail);
    controller.close();
  } catch { /* Stream already closed when the interrupted browser tab dropped the connection. */ }
}

/**
 * Deterministic offline npm registry with 16 multi-file packages and a mid-stream hold gate.
 * When `holdAfter(N)` is active, the package at position `N` in install order (bun installs in
 * sorted name order) streams half its archive and stays open until `releaseHeld()`, so
 * `bun install` cannot finish before interruption. Every other archive completes normally, so
 * the `N` packages before it are extracted into IndexedDB first. Holding one response by
 * position, rather than every response after the first `N` to arrive, keeps that true whatever
 * order concurrent requests arrive in, and leaves no earlier request queued behind held ones.
 */
function startLocalRegistry(packageCount = 16): LocalRegistry {
  const packages = new Map<string, { meta: string; tgz: Uint8Array }>();
  const dependencies: Record<string, string> = {};
  let tarballsCompleted = 0;
  let heldPosition: number | null = null;
  // Each package's position in install order, filled once every package exists.
  const installPosition = new Map<string, number>();
  const heldReleases = new Set<() => void>();
  const heldWaiters = new Set<() => void>();
  const notifyHeld = () => {
    if (heldReleases.size === 0) return;
    for (const resolve of Array.from(heldWaiters)) {
      heldWaiters.delete(resolve);
      resolve();
    }
  };
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "no-store",
  };
  const heldTarballStream = (bytes: Uint8Array) => {
    const split = Math.max(1, Math.floor(bytes.byteLength / 2));
    let releaseFn: (() => void) | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, split)));
        const tail = new Uint8Array(bytes.subarray(split));
        const release = () => {
          heldReleases.delete(release);
          closeHeldStream(controller, tail);
        };
        releaseFn = release;
        heldReleases.add(release);
        notifyHeld();
      },
      cancel() {
        if (releaseFn) heldReleases.delete(releaseFn);
      },
    });
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
        if (heldPosition !== null && installPosition.get(name) === heldPosition) {
          return new Response(heldTarballStream(entry.tgz), {
            headers: { ...corsHeaders, "content-type": "application/gzip" },
          });
        }
        tarballsCompleted++;
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
  for (const [position, name] of Array.from(packages.keys()).sort().entries()) installPosition.set(name, position);
  const releaseHeld = () => {
    for (const release of Array.from(heldReleases)) release();
  };
  return {
    base,
    dependencies,
    get tarballsCompleted() { return tarballsCompleted; },
    get heldCount() { return heldReleases.size; },
    holdAfter(position: number | null) { heldPosition = position; },
    waitForHeld(timeoutMs = 30_000): Promise<void> {
      if (heldReleases.size > 0) return Promise.resolve();
      return new Promise((resolvePromise, reject) => {
        const done = () => { clearTimeout(timer); resolvePromise(); };
        const timer = setTimeout(() => {
          heldWaiters.delete(done);
          reject(new Error(`Expected an in-flight held tarball within ${timeoutMs} ms (completed=${tarballsCompleted})`));
        }, timeoutMs);
        heldWaiters.add(done);
      });
    },
    releaseHeld,
    async close() {
      releaseHeld();
      await server.stop(true);
    },
  };
}

function attachCorruptionGuard(page: Page, errors: string[], isInterrupting?: () => boolean): void {
  page.on("pageerror", error => {
    const message = error.message;
    if (isCancelledLoadingStatusPoll(error)) return;
    // WebKit surfaces aborted cross-origin fetches during intentional reload/close as access-control pageerrors,
    // and work still pending in the page it is tearing down (such as archive downloads) as "Context is stopped".
    if (isInterrupting?.() && /due to access control checks|cancelled|aborted|Load failed|Context is stopped/i.test(message)) return;
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

    // 5 consecutive hard interruptions while a large write + flush batch is proved still pending after a worker round-trip.
    for (let cycle = 0; cycle < 5; cycle++) {
      const state = await page.evaluate(async cycle => {
        const sb = Reflect.get(globalThis, "sandbox");
        if (!sb?.fs) throw new Error("Missing window.sandbox.fs");
        let flushSettled = false;
        const payload = `cycle=${cycle} payload=${"a".repeat(16384)}`;
        const firstWrite = sb.fs.writeFile(`/home/user/app/inflight-enter-${cycle}.txt`, `enter=${cycle}`);
        for (let i = 0; i < 120; i++) {
          const path = `/home/user/app/stress-${cycle}-${i}.txt`;
          void sb.fs.writeFile(path, `${i}:${payload}`).catch(() => {});
          if (i % 20 === 0) void sb.fs.flush(path).catch(() => {});
        }
        void sb.fs.flush().then(() => { flushSettled = true; }, () => { flushSettled = true; });
        // Await the first worker write AND a real timer turn so any already-settled flush promise would have flipped flushSettled.
        await firstWrite;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { flushInFlight: !flushSettled };
      }, cycle);
      expect(state.flushInFlight).toBe(true);

      // Interrupt immediately with no post-burst sleep while the flush is still open in the FS worker.
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
    mkdirp(path: string): Promise<void>;
    readFile(path: string): Promise<Uint8Array | undefined>;
    listFiles(path?: string): Promise<string[]>;
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

async function waitForExtractedPackage(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(async () => {
      const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
      const files = await pg?.fs?.listFiles?.("/home/user");
      return Boolean(files?.some(file => /stress-pkg-\d+(?:@[^/]+)?\/(?:index\.js|package\.json)$/.test(file)));
    });
    if (found) return;
    await page.waitForTimeout(25);
  }
  throw new Error(`No extracted stress-pkg file appeared in persistent VFS within ${timeoutMs} ms`);
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
      // Staging a killed install would leave, which the next boot clears, and a file it keeps.
      await pg.fs.mkdirp("/tmp/bun-wasm-early-leftover/1");
      await pg.fs.writeFile("/tmp/bun-wasm-early-leftover/1/package.json", "{}");
      await pg.fs.writeFile("/tmp/kept.txt", "kept");
      await pg.fs.flush();
    }, { base: registry.base, dependencies: registry.dependencies, baseline });

    // 4 consecutive hard interruptions mid-`bun install`: real tarballs are completed and extracted into the
    // persistent VFS while the next tarball stream stays held open mid-body so `bun install` cannot finish.
    for (let cycle = 0; cycle < 4; cycle++) {
      const beforeCompleted = registry.tarballsCompleted;
      registry.holdAfter(1 + cycle);
      const rmExit = await page.evaluate(async ({ base, dependencies }) => {
        const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
        if (!pg?.fs || !pg?.shell) throw new Error("Missing playground handle");
        await pg.fs.writeFile("/home/user/package.json", JSON.stringify({ name: "stress-install", dependencies }));
        await pg.fs.writeFile("/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(base)}\n`);
        await pg.fs.flush();
        // Clear both node_modules and the Bun package cache before starting so any observed extracted file is from this cycle.
        await pg.shell.submit("rm -rf node_modules bun.lock ~/.bun/install/cache");
        const exitCode = pg.shell.lastExit;
        if (exitCode !== 0) return exitCode;
        void pg.shell.submit("bun install --no-cache").catch(() => {});
        return 0;
      }, { base: registry.base, dependencies: registry.dependencies });
      expect(rmExit).toBe(0);

      await registry.waitForHeld(30_000);
      // Poll page.evaluate directly (Playwright's waitForFunction treats async Promise returns as truthy)
      // to confirm the guest actually extracted at least one package file into persistent VFS while heldCount > 0.
      await waitForExtractedPackage(page, 30_000);
      expect(registry.tarballsCompleted).toBeGreaterThan(beforeCompleted);
      expect(registry.heldCount).toBeGreaterThan(0);
      await interruptPage(cycle);
      registry.releaseHeld();

      await waitForPlaygroundReady(page, `after interrupted install cycle ${cycle}`);
      expect(await readPlaygroundFile(page, "/home/user/.baseline-install.txt")).toBe(baseline);
      // Boot cleared the staging of the killed install and the planted leftover, nothing else.
      const temporary = await page.evaluate(async () => {
        const pg = Reflect.get(globalThis, "playground") as unknown as PlaygroundHandle | undefined;
        return (await pg?.fs?.listFiles("/tmp")) ?? [];
      });
      expect(temporary.filter(path => path.includes("bun-wasm-early-"))).toEqual([]);
      expect(await readPlaygroundFile(page, "/tmp/kept.txt")).toBe("kept");
      expect(errors).toEqual([]);
    }

    // Release hold gate; final clean install must exit 0, flush, and survive reload on the same workspace.
    registry.holdAfter(null);
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

async function stressNativeCommitBoundaries(context: BrowserContext, scratchDir: string): Promise<void> {
  const out = join(scratchDir, "persistence-dist");
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
  const dbsToDelete: { name: string; storage: "indexeddb" | "opfs" }[] = [];
  let page: Page | undefined;

  try {
    const openHarness = async () => {
      const next = await context.newPage();
      attachCorruptionGuard(next, errors);
      await navigateTestPage(next, server.url.href);
      await next.waitForFunction(() => Boolean(Reflect.get(globalThis, "persistenceHarness")));
      return next;
    };

    // Deterministic native mid-commit hard closes for BOTH IndexedDB (transaction boundary) and OPFS (partial payload/snapshot writes).
    const cases: { storage: "indexeddb" | "opfs"; boundary: "transaction" | "payload" | "snapshot" }[] = [
      { storage: "indexeddb", boundary: "transaction" },
      { storage: "indexeddb", boundary: "transaction" },
      { storage: "indexeddb", boundary: "transaction" },
      { storage: "opfs", boundary: "payload" },
      { storage: "opfs", boundary: "snapshot" },
      { storage: "opfs", boundary: "payload" },
      { storage: "opfs", boundary: "snapshot" },
    ];

    for (const [cycle, { storage, boundary }] of cases.entries()) {
      const db = `bunwasm-commit-stress-${storage}-${cycle}-${crypto.randomUUID()}`;
      dbsToDelete.push({ name: db, storage });
      page = await openHarness();
      const old = await page.evaluate(async ({ dbName, storage }) => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        await h.direct("open", { name: dbName, storage });
        return h.direct("seedInterrupted");
      }, { dbName: db, storage });

      await page.evaluate(b => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        void h.direct("interruptCommit", b).catch(() => {});
      }, boundary);
      await page.waitForFunction(requirePartial => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        return Boolean(h?.state?.commitStarted && (!requirePartial || h?.state?.partialWrite === true));
      }, storage === "opfs", { timeout: 30_000 });
      if (storage === "opfs") {
        const observed = await page.evaluate(() => {
          const state = Reflect.get(globalThis, "persistenceHarness").state;
          return { boundary: state.boundary, partialWrite: state.partialWrite };
        });
        expect(observed).toEqual({ boundary, partialWrite: true });
      }

      // Hard-close the page at the live native commit boundary.
      await page.close();
      page = await openHarness();
      const recovered = await page.evaluate(async ({ dbName, storage }) => {
        const h = Reflect.get(globalThis, "persistenceHarness");
        await h.direct("open", { name: dbName, storage });
        const result = await h.direct("inspectInterrupted");
        await h.destroy();
        return result;
      }, { dbName: db, storage });
      expect(["old", "new"]).toContain(recovered.state);
      if (recovered.state === "old") expect(recovered.metadata).toEqual(old.metadata);
      expect(errors).toEqual([]);
      await page.close();
      page = undefined;
    }

    // Final clean OPFS write + flush + reload confirms persistent OPFS remains healthy and durable.
    const cleanDb = `bunwasm-opfs-final-${crypto.randomUUID()}`;
    dbsToDelete.push({ name: cleanDb, storage: "opfs" });
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
    for (const item of dbsToDelete) {
      await page.evaluate(({ name, storage }) => Reflect.get(globalThis, "persistenceHarness").deleteDatabase(name, storage), item).catch(() => {});
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
      await stressNativeCommitBoundaries(context, scratch);

      expect(verifySite(siteDir)).toEqual(before);
    } finally {
      await context?.close().catch(() => {});
      await sandboxServer?.stop();
      await playgroundServer?.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
