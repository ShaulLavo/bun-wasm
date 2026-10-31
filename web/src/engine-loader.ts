import { programKind, programProfile, type PairedEngine } from "../../src/engine-kind.ts";
import { prepareProgram } from "../../src/assets.ts";
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
  // Opt-in: no default build makes bun-hermes.wasm, and the engine menu leaves it out.
  hermes: { name: "Hermes", wasm: "bun-hermes.wasm", script: "scripts/build-bun-hermes.sh" },
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
  const requested = new URL(url, location.href);
  const name = requested.pathname;
  if (name.replace(/\.gz$/, "").endsWith("bun-tools.wasm")) return loadVerifiedTools(url, progress);
  for (const kind of ["quickjs", "jsc", "hermes"] as const) {
    const standard = new URL(ENGINES[kind].wasm, location.href);
    if (requested.origin === standard.origin && requested.pathname.replace(/\.gz$/, "") === standard.pathname) return loadPaired(url, kind, progress);
  }
  progress("loading bun.wasm…");
  const build = assetBuild(url);
  const key = new URL(url, location.href).href;
  const cached = build ? await cachedEngine(key, build) : null;
  let size = 0;
  if (cached) {
    progress("compiling cached bun.wasm…");
    const started = performance.now();
    const compiled = await compileCached(cached, key);
    if (compiled) {
      const { bytes, module } = compiled;
      size = bytes.length;
      performance.mark("bunwasm:engine-cache-hit");
      measureStartup("compile", started, { cached: true });
      const kind = programKind(module);
      if (kind !== "single") return loadProgramSide(url, kind, { bytes, build }, progress, false);
      return { module, size, build };
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
      chunks.push(chunk);
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
  const kind = programKind(module);
  if (kind !== "single") {
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    return loadProgramSide(url, kind, { bytes, build: null }, progress, false);
  }
  const engine = { module, size };
  if (build) setTimeout(() => void cacheIfExpected(key, build, chunks, size), 0);
  return { ...engine, build };
}

async function compileCached(response: Response, key: string) {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, module: await WebAssembly.compile(bytes) };
  } catch {
    await evictEngine(key);
    return null;
  }
}

async function loadPaired(url: string, expected: PairedEngine, progress: (text: string) => void) {
  const core = await loadVerifiedFile(url, programProfile(expected).core, progress);
  // Preparation compiles asynchronously and rejects a core that declares another engine.
  return loadProgramSide(url, expected, core, progress, true);
}

async function loadProgramSide(url: string, kind: PairedEngine, core: { bytes: Uint8Array<ArrayBuffer>; build: string | null }, progress: (text: string) => void, verifyBuild: boolean) {
  const profile = programProfile(kind);
  const sideUrl = new URL(profile.side, new URL(url, location.href));
  const side = await loadVerifiedFile(sideUrl.href, profile.side, progress, verifyBuild);
  const module = await prepareProgram({ kind, core: core.bytes, side: side.bytes });
  return { module, size: core.bytes.length + side.bytes.length, build: core.build };
}

async function loadVerifiedTools(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string }> {
  const { bytes, build } = await loadVerifiedFile(url, "bun-tools.wasm", progress);
  if (build === null) throw new Error("bun-tools.wasm: build manifest fingerprint is missing");
  return { module: await prepareProgram({ kind: "single", core: bytes }), size: bytes.length, build };
}

async function loadVerifiedFile(url: string, name: string, progress: (text: string) => void, verifyBuild = true): Promise<{ bytes: Uint8Array<ArrayBuffer>; build: string | null }> {
  const build = verifyBuild ? assetBuild(name) : null;
  if (verifyBuild && build === null) throw new Error(`${name}: build manifest fingerprint is missing`);
  const key = new URL(url, location.href).href;
  const cached = build === null ? null : await cachedEngine(key, build);
  if (cached && build !== null) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    try { await verifyArtifact(name, bytes, build); }
    catch (error) { await evictEngine(key); throw error; }
    progress(`verified cached ${name} (${mb(bytes.length)})…`);
    return { bytes, build };
  }
  progress(`downloading ${name}…`);
  const gzUrl = url.endsWith(".gz") ? url : `${url}.gz`;
  let response = await fetch(build === null ? gzUrl : `${gzUrl}?v=${build}`);
  const gzipped = response.ok;
  if (!gzipped) response = await fetch(url);
  if (response.status === 404) throw new WasmMissing(`${url}: HTTP 404`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: empty response body`);
  const body = gzipped ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (build !== null) await verifyArtifact(name, bytes, build);
  else verifyWasm(name, bytes);
  progress(`verified ${name} (${mb(bytes.length)})…`);
  if (build !== null && await cacheEngine(key, build, new Response(bytes, { headers: { "content-type": "application/wasm", "content-length": String(bytes.length) } }))) {
    performance.mark("bunwasm:engine-cache-stored", { detail: { url: key, build } });
  }
  return { bytes, build };
}

function verifyWasm(name: string, bytes: Uint8Array<ArrayBuffer>): void {
  if (!WebAssembly.validate(bytes)) throw new Error(`${name}: downloaded bytes are not a valid WebAssembly module`);
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
