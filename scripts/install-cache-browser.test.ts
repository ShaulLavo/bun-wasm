import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";

// Tests here start real browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

type InstallCacheModule = typeof import("../web/src/net/install-cache.ts");

const TARBALL = "application/vnd.bun.install-tarball";
const ENTRY = resolve(import.meta.dir, "../web/src/net/install-cache.ts");

async function buildBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    format: "esm",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(result.logs.map(log => log.message).join("\n"));
  }
  const output = result.outputs[0];
  if (!output) throw new Error("install-cache browser bundle produced no output");
  return output.text();
}

const bundlePromise = buildBundle();

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: installFetch skips cold cache.match, serializes puts, and hits warm tarballs across reload`, async () => {
    const bundle = await bundlePromise;
    let offline = false;
    let tarballRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/") {
          return new Response("<!doctype html><title>install-cache test</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/install-cache.js") {
          return new Response(bundle, {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
        if (url.pathname.startsWith("/tarballs/")) {
          tarballRequests++;
          if (offline) return new Response("offline", { status: 503 });
          return new Response(`tarball-payload:${url.pathname}`, {
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": "no-store",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const profile = mkdtempSync(join(tmpdir(), `bun-wasm-install-cache-${engine.name()}-`));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const base = `http://127.0.0.1:${server.port}`;

      await page.goto(`${base}/`);
      const cold = await page.evaluate(async ({ baseUrl, accept }) => {
        const stats = { opens: 0, keys: 0, matches: 0, puts: 0, activePuts: 0, peakPuts: 0 };
        const originalOpen = CacheStorage.prototype.open;
        const originalKeys = Cache.prototype.keys;
        const originalMatch = Cache.prototype.match;
        const originalPut = Cache.prototype.put;
        CacheStorage.prototype.open = function (name) {
          if (name === "bun-wasm-install-v1") stats.opens++;
          return originalOpen.call(this, name);
        };
        Cache.prototype.keys = function (...args) {
          stats.keys++;
          return originalKeys.apply(this, args);
        };
        Cache.prototype.match = function (...args) {
          stats.matches++;
          return originalMatch.apply(this, args);
        };
        Cache.prototype.put = function (...args) {
          stats.puts++;
          stats.activePuts++;
          stats.peakPuts = Math.max(stats.peakPuts, stats.activePuts);
          return Promise.resolve(originalPut.apply(this, args)).finally(() => {
            stats.activePuts--;
          });
        };

        const moduleUrl = `${baseUrl}/install-cache.js`;
        const mod = await import(moduleUrl) as InstallCacheModule;
        const count = 20;
        const urls = Array.from({ length: count }, (_, index) => `${baseUrl}/tarballs/pkg-${index}.tgz`);
        const bodies = await Promise.all(urls.map(async url => {
          const response = await mod.installFetch(url, { method: "GET", headers: { accept } });
          return response.text();
        }));
        const coldMatches = stats.matches;
        const coldOpens = stats.opens;
        const coldKeys = stats.keys;

        // Wait for the serialized background put queue to persist every tarball.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const cache = await originalOpen.call(caches, "bun-wasm-install-v1");
          const stored = await originalKeys.call(cache);
          if (stored.length === count) break;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
        }
        const finalCount = (await originalKeys.call(await originalOpen.call(caches, "bun-wasm-install-v1"))).length;
        return {
          bodies,
          coldMatches,
          coldOpens,
          coldKeys,
          puts: stats.puts,
          peakPuts: stats.peakPuts,
          finalCount,
        };
      }, { baseUrl: base, accept: TARBALL });

      expect(cold.bodies).toEqual(Array.from({ length: 20 }, (_, index) => `tarball-payload:/tarballs/pkg-${index}.tgz`));
      expect(cold.coldOpens).toBe(1);
      expect(cold.coldKeys).toBe(1);
      expect(cold.coldMatches).toBe(0);
      expect(cold.puts).toBe(20);
      expect(cold.peakPuts).toBe(1);
      expect(cold.finalCount).toBe(20);
      expect(tarballRequests).toBe(20);

      // Warm hits in the same session with the origin returning 503.
      offline = true;
      const sameSessionWarm = await page.evaluate(async ({ baseUrl, accept }) => {
        const moduleUrl = `${baseUrl}/install-cache.js`;
        const mod = await import(moduleUrl) as InstallCacheModule;
        const urls = Array.from({ length: 20 }, (_, index) => `${baseUrl}/tarballs/pkg-${index}.tgz`);
        return Promise.all(urls.map(async url => {
          const response = await mod.installFetch(url, { method: "GET", headers: { accept } });
          return response.text();
        }));
      }, { baseUrl: base, accept: TARBALL });
      expect(sameSessionWarm).toEqual(cold.bodies);
      expect(tarballRequests).toBe(20);

      // Warm hits after a full page reload (fresh JS heap, warm native CacheStorage).
      await page.reload();
      const reloadedWarm = await page.evaluate(async ({ baseUrl, accept }) => {
        let keys = 0;
        let matches = 0;
        const originalKeys = Cache.prototype.keys;
        const originalMatch = Cache.prototype.match;
        Cache.prototype.keys = function (...args) {
          keys++;
          return originalKeys.apply(this, args);
        };
        Cache.prototype.match = function (...args) {
          matches++;
          return originalMatch.apply(this, args);
        };
        const moduleUrl = `${baseUrl}/install-cache.js`;
        const mod = await import(moduleUrl) as InstallCacheModule;
        const urls = Array.from({ length: 20 }, (_, index) => (
          index === 0
            ? `${baseUrl}/tarballs/nested/../pkg-0.tgz`
            : `${baseUrl}/tarballs/pkg-${index}.tgz`
        ));
        const bodies = await Promise.all(urls.map(async url => {
          const response = await mod.installFetch(url, { method: "GET", headers: { accept } });
          return response.text();
        }));
        const cleared = await mod.clearInstallCache();
        const existsAfterClear = await caches.has("bun-wasm-install-v1");
        return { bodies, keys, matches, cleared, existsAfterClear };
      }, { baseUrl: base, accept: TARBALL });

      expect(reloadedWarm.bodies).toEqual(cold.bodies);
      expect(reloadedWarm.keys).toBe(1);
      expect(reloadedWarm.matches).toBe(20);
      expect(reloadedWarm.cleared).toBe(true);
      expect(reloadedWarm.existsAfterClear).toBe(false);
      expect(tarballRequests).toBe(20);

      // After clearInstallCache, a fresh cold miss skips cache.match again.
      offline = false;
      const postClear = await page.evaluate(async ({ baseUrl, accept }) => {
        let matches = 0;
        const originalMatch = Cache.prototype.match;
        Cache.prototype.match = function (...args) {
          matches++;
          return originalMatch.apply(this, args);
        };
        const moduleUrl = `${baseUrl}/install-cache.js`;
        const mod = await import(moduleUrl) as InstallCacheModule;
        const text = await (await mod.installFetch(`${baseUrl}/tarballs/pkg-0.tgz`, { method: "GET", headers: { accept } })).text();
        return { text, matches };
      }, { baseUrl: base, accept: TARBALL });
      expect(postClear).toEqual({ text: "tarball-payload:/tarballs/pkg-0.tgz", matches: 0 });
      expect(tarballRequests).toBe(21);
      expect(errors).toEqual([]);
    } finally {
      await context.close().catch(() => {});
      rmSync(profile, { recursive: true, force: true });
      server.stop(true);
    }
  }, 60_000);
}
