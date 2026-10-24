// Engine metadata and downloads are usable before the execution/process graph loads.
import { activated } from "./preview";
import { assetBuild, cachedEngine, cacheEngine, evictEngine } from "./startup-cache";
import { measureStartup } from "./startup";
import type { Engine } from "./bun-executor";

export type { Engine } from "./bun-executor";

/** What each `?engine=` loads. The browser engine runs the program in the page's own JS engine. */
export const ENGINES: Record<Engine, { name: string; wasm: string; script: string }> = {
  quickjs: { name: "QuickJS", wasm: "bun.wasm", script: "scripts/build.sh" },
  jsc: { name: "JavaScriptCore", wasm: "bun-jsc.wasm", script: "scripts/build-bun-jsc.sh" },
  browser: { name: "Browser (native)", wasm: "bun-browser.wasm", script: "scripts/build-bun-browser.sh" },
};

export function isEngine(name: string | null): name is Engine {
  return name !== null && Object.hasOwn(ENGINES, name);
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class WasmMissing extends Error {}

/**
 * Fetches and compiles a wasm module. Sites ship it gzipped (static hosts cap file sizes, and it is
 * 3-4x smaller) and the page decompresses it; a plain .wasm URL works too. Throws WasmMissing on 404.
 */
export async function loadWasm(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string | null }> {
  if (url.endsWith("bun-tools.wasm")) return loadVerifiedTools(url, progress);
  progress("loading bun.wasm…");
  const build = assetBuild(url);
  const key = new URL(url, location.href).href;
  const cached = build ? await cachedEngine(key, build) : null;
  let size = 0;
  if (cached) {
    progress("compiling cached bun.wasm…");
    const started = performance.now();
    try {
      size = Number(cached.headers.get("content-length"));
      const module = await WebAssembly.compileStreaming(cached);
      performance.mark("bunwasm:engine-cache-hit");
      measureStartup("compile", started, { cached: true });
      return { module, size, build };
    } catch {
      await evictEngine(key);
    }
  }
  progress("downloading bun.wasm…");
  const started = performance.now();
  const gzUrl = url.endsWith(".gz") ? url : `${url}.gz`;
  // The build hash in the query gives every build its own URL, so a CDN edge that still holds the
  // previous build right after a deploy can't serve it in place of this one.
  let res = await fetch(build ? `${gzUrl}?v=${build}` : gzUrl);
  const gzipped = res.ok;
  if (!gzipped) res = await fetch(url);
  if (res.status === 404) throw new WasmMissing(`${url}: HTTP 404`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  let lastProgress = 0;
  const counter = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      received += chunk.length;
      if (performance.now() - lastProgress >= 50 || received === total) {
        progress(`downloading bun.wasm… ${mb(received)}${total ? ` / ${mb(total)}` : ""}`);
        lastProgress = performance.now();
      }
      controller.enqueue(chunk);
    },
    flush() {
      measureStartup("download", started, { bytes: received });
      progress("decompressing and compiling bun.wasm…");
    },
  });
  if (!res.body) throw new Error(`${url}: empty response body`);
  let body = res.body.pipeThrough(counter);
  const decompressing = performance.now();
  if (gzipped) body = body.pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  body = body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      size += chunk.length;
      if (build) chunks.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      measureStartup("decompress", decompressing, { bytes: size, gzipped });
      progress(`compiling bun.wasm (${mb(size)})…`);
    },
  }));
  // Compilation consumes the decompressed stream while the remaining bytes are still arriving.
  const compiling = performance.now();
  const response = new Response(body, { headers: { "content-type": "application/wasm" } });
  const module = await WebAssembly.compileStreaming(response);
  measureStartup("compile", compiling, { streaming: true });
  const engine = { module, size };
  if (build) setTimeout(() => void cacheIfExpected(key, build, chunks, size), 0);
  return { ...engine, build };
}

async function loadVerifiedTools(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string }> {
  const build = assetBuild(url);
  if (!build) throw new Error("bun-tools.wasm: build manifest fingerprint is missing");
  const key = new URL(url, location.href).href;
  const cached = await cachedEngine(key, build);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    try { await verifyArtifact("bun-tools.wasm", bytes, build); }
    catch (error) { await evictEngine(key); throw error; }
    progress(`compiling cached bun-tools.wasm (${mb(bytes.length)})…`);
    return { module: await WebAssembly.compile(bytes), size: bytes.length, build };
  }
  progress("downloading bun-tools.wasm…");
  const gzUrl = url.endsWith(".gz") ? url : `${url}.gz`;
  let response = await fetch(`${gzUrl}?v=${build}`);
  const gzipped = response.ok;
  if (!gzipped) response = await fetch(url);
  if (response.status === 404) throw new WasmMissing(`${url}: HTTP 404`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: empty response body`);
  const body = gzipped ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
  const wasm = new Uint8Array(await new Response(body).arrayBuffer());
  await verifyArtifact("bun-tools.wasm", wasm, build);
  progress(`compiling bun-tools.wasm (${mb(wasm.length)})…`);
  const module = await WebAssembly.compile(wasm);
  if (await cacheEngine(key, build, new Response(wasm, { headers: { "content-type": "application/wasm", "content-length": String(wasm.length) } }))) {
    performance.mark("bunwasm:engine-cache-stored", { detail: { url: key, build } });
  }
  return { module, size: wasm.length, build };
}

async function verifyArtifact(name: string, bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actual = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error(`${name} integrity mismatch: expected ${expected}, received ${actual}`);
}

/** Caches the downloaded engine only if its bytes are the build the page expects. */
async function cacheIfExpected(key: string, build: string, chunks: Uint8Array<ArrayBuffer>[], size: number): Promise<void> {
  const blob = new Blob(chunks);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== build) return;
  const headers = { "content-type": "application/wasm", "content-length": String(size) };
  await cacheEngine(key, build, new Response(blob, { headers }));
}

// The service worker at ./__bunwasm/ (sw.ts) serves named module URLs for import cycles.
// Acyclic modules use blob URLs, including when WebKit starts an uncontrolled worker in the scope.
export const MODULE_SCOPE = "./__bunwasm/";

export async function registerModuleScope(): Promise<boolean> {
  const container = navigator.serviceWorker;
  if (!container) return false;
  try {
    const registration = await container.register("./sw.js", { scope: MODULE_SCOPE });
    await activated(registration);
    return registration.active !== null;
  } catch (err) {
    console.warn("module service worker registration failed:", err);
    return false;
  }
}
