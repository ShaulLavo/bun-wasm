import { recordProgramMemory } from "../../src/program-memory.ts";
import { pairedEngineKinds, programKind, programProfile, type Engine, type PairedEngine } from "../../src/engine-kind.ts";
import { prepareProgram } from "../../src/assets.ts";
// Engine metadata and downloads are usable before the execution/process graph loads.
import { activated } from "./preview";
import { assetBuild, cachedEngine, cacheEngine, evictEngine } from "./startup-cache";
import { measureStartup } from "./startup";
import { observeCompile, withoutCompileSpans } from "./compile-observer";
import { profileAsset, requireProfileEngine, verifyMemoryProfile, type ProgramMemoryProfile } from "./program-profile";

export type { Engine } from "../../src/engine-kind.ts";

/** What each `?engine=` loads. The browser engine runs the program in the page's own JS engine. */
export const ENGINES: Record<Engine, { name: string; wasm: string; script: string }> = {
  quickjs: { name: "QuickJS", wasm: "bun.wasm", script: "scripts/build.sh" },
  spidermonkey: { name: "SpiderMonkey (experimental)", wasm: "bun-spidermonkey.wasm", script: "scripts/build-bun-spidermonkey.sh" },
  jsc: { name: "JavaScriptCore", wasm: "bun-jsc.wasm", script: "scripts/build-bun-jsc.sh" },
  browser: { name: "Browser (native)", wasm: "bun-browser.wasm", script: "scripts/build-bun-browser.sh" },
};

export function engineBuildHint(engine: Engine): string {
  const { script, wasm } = ENGINES[engine];
  if (engine === "spidermonkey") return `Stage a matched ${wasm} and sibling spidermonkey-engine.wasm with SPIDERMONKEY_WASM=/absolute/path/${wasm} bun web/build.ts. Produce the pair with ${script}.`;
  return `Build it with ${script} (dist/${wasm}), then rebuild web/.`;
}

/** Optional engines need the complete staged pair; loading still verifies its bytes and profile. */
export function engineUnavailable(engine: Engine, memoryProfile: ProgramMemoryProfile = "split"): string | null {
  if (engine !== "spidermonkey" && memoryProfile === "split") return null;
  if (engine === "browser") return null;
  const { core, side } = programProfile(engine);
  if (assetBuild(profileAsset(core, memoryProfile)) !== null && assetBuild(profileAsset(side, memoryProfile)) !== null) return null;
  if (memoryProfile === "shared-group") return `${ENGINES[engine].name} shared-group is not in this build. Stage its matching pair with SHARED_${engine.toUpperCase()}_PROGRAM=/absolute/program before building this host.`;
  return `SpiderMonkey is not in this build. ${engineBuildHint(engine)}`;
}

export function isEngine(name: string | null): name is Engine {
  return name !== null && Object.hasOwn(ENGINES, name);
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class WasmMissing extends Error {}

/** Retain verified tools for one consumer; optional persistence can finish after launch. */
export function createToolsLoader(): () => Promise<WebAssembly.Module> {
  let loading: Promise<WebAssembly.Module> | undefined;
  return () => loading ??= loadWasm("bun-tools.wasm", () => {})
    .then(result => result.module)
    .catch(error => { loading = undefined; throw error; });
}

/** Select the engine and memory profile before fetching any program bytes. */
export async function loadEngineProgram(engine: Engine, profile: ProgramMemoryProfile, progress: (text: string) => void, override?: string) {
  requireProfileEngine(engine, profile);
  const unavailable = engineUnavailable(engine, profile);
  if (unavailable) throw new Error(unavailable);
  const asset = override ?? profileAsset(ENGINES[engine].wasm, profile);
  const url = new URL(asset, location.href).href;
  // The build fingerprint (and so the engine cache) is keyed by the staged asset's name.
  const loaded = engine === "browser" ? await loadWasm(url, progress, override === undefined ? asset : undefined)
    : await loadPaired(url, engine, progress, profile);
  const expected = engine === "browser" ? "single" : engine;
  if (programKind(loaded.module) !== expected) throw new TypeError(`Bun engine mismatch: selected ${engine}`);
  verifyMemoryProfile(loaded.module, profile);
  return loaded;
}

/**
 * Fetches and compiles a wasm module. Sites ship Brotli and gzip twins (static hosts cap file sizes,
 * and they are 3-4x smaller); see fetchArtifact for how the page picks one. Throws WasmMissing on 404.
 */
export async function loadWasm(url: string, progress: (text: string) => void, asset = url): Promise<{ module: WebAssembly.Module; size: number; build: string | null }> {
  const requested = new URL(url, location.href);
  const name = requested.pathname;
  if (name.replace(/\.gz$/, "").endsWith("bun-tools.wasm")) return loadVerifiedTools(url, progress);
  for (const kind of pairedEngineKinds) {
    const standard = new URL(ENGINES[kind].wasm, location.href);
    if (requested.origin === standard.origin && requested.pathname.replace(/\.gz$/, "") === standard.pathname) return loadPaired(url, kind, progress);
  }
  progress("loading bun.wasm…");
  const build = assetBuild(asset);
  const key = new URL(url, location.href).href;
  const lookup = performance.now();
  const cached = build ? await cachedEngine(key, build) : null;
  measureStartup("cache-lookup", lookup, { name, hit: cached !== null });
  const restored = cached && build ? await loadCachedWasm(url, key, cached, build, progress) : null;
  if (restored) return restored;
  let streamed: Awaited<ReturnType<typeof streamWasm>>;
  try {
    streamed = await streamWasm(url, build, progress);
  } catch (error) {
    // A failure anywhere in the download, headers or body, can still be served from build-checked
    // bytes a first-visit marker skipped. A missing asset stays missing.
    const stored = build && !(error instanceof WasmMissing) ? await cachedEngine(key, build, true) : null;
    const fallback = stored && build ? await loadCachedWasm(url, key, stored, build, progress) : null;
    if (fallback) return fallback;
    throw error;
  }
  const { module, bytes } = streamed;
  const kind = programKind(module);
  if (kind !== "single") return loadProgramSide(url, kind, { bytes, build: null }, progress, false);
  recordProgramMemory(module, bytes);
  if (build) setTimeout(() => void cacheIfExpected(key, build, bytes), 0);
  return { module, size: bytes.length, build };
}

/** Downloads and stream-compiles a module, keeping its bytes. */
async function streamWasm(url: string, build: string | null, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; bytes: Uint8Array<ArrayBuffer> }> {
  progress("downloading bun.wasm…");
  const started = performance.now();
  return fromArtifact(url, build, url, artifact => compileArtifact(artifact, started, progress));
}

async function compileArtifact({ response: res, body: downloaded, gzipped }: Artifact, started: number, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; bytes: Uint8Array<ArrayBuffer> }> {
  let size = 0;
  const total = streamedLength(res, gzipped);
  const encoding = gzipped ? "gzip-page" : res.headers.get("content-encoding") ?? "identity";
  let received = 0;
  // The first chunk always reports, however young the page is.
  let lastProgress = Number.NEGATIVE_INFINITY;
  const counter = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      received += chunk.length;
      if (performance.now() - lastProgress >= 50 || received === total) {
        progress(`downloading bun.wasm… ${mb(received)}${total > 0 && total >= received ? ` / ${mb(total)}` : ""}`);
        lastProgress = performance.now();
      }
      controller.enqueue(chunk);
    },
    flush() {
      measureStartup("download", started, { bytes: received, encoding });
      progress("decompressing and compiling bun.wasm…");
    },
  });
  let body = downloaded.pipeThrough(counter);
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
  // Streaming completion includes download and decompression waits. No direct compile span is available.
  const module = await WebAssembly.compileStreaming(response);
  measureStartup("compile", compiling, { streaming: true });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks.length = 0;
  return { module, bytes };
}

type Artifact = { response: Response; body: ReadableStream<Uint8Array<ArrayBuffer>>; gzipped: boolean };

/**
 * Why the logical URL gave way to the `.gz` twin: its HTTP status, the failure that interrupted it,
 * or a body that does not start like a WebAssembly module, kept in case no twin exists.
 */
type Miss = { status: number; error?: unknown; held?: Artifact };

/**
 * Fetch the logical `.wasm` URL first and pass it to `consume`. Negotiating hosts (site/worker.ts,
 * web/serve.ts) answer it with the Brotli or gzip twin and a native Content-Encoding, which the
 * browser decodes as the bytes arrive (Safari has no Brotli DecompressionStream). A plain static host
 * ships no raw guest; when the logical URL is missing, is not a WebAssembly module (an index page),
 * or fails in transport or decoding, the `.gz` twin is consumed instead, gunzipped here. A `.gz` URL
 * is fetched as given. The build hash in the query gives every build its own URL, so a CDN edge that
 * still holds the previous build right after a deploy can't serve it in place of this one.
 * Throws WasmMissing when both are missing.
 */
async function fromArtifact<T>(url: string, build: string | null, label: string, consume: (artifact: Artifact) => Promise<T>): Promise<T> {
  const requested = new URL(url, location.href);
  if (build !== null) requested.searchParams.set("v", build);
  if (requested.pathname.endsWith(".gz")) return consume(gzipArtifact(await fetch(requested.href), { status: 404 }, label));
  const logical = await attempt(requested.href, consume);
  if ("value" in logical) return logical.value;
  requested.pathname += ".gz";
  return fallBack(requested.href, logical, label, consume);
}

async function fallBack<T>(href: string, logical: Miss, label: string, consume: (artifact: Artifact) => Promise<T>): Promise<T> {
  const { held } = logical;
  if (!held) return consume(gzipArtifact(await fetch(href), logical, label));
  const twin = await fetch(href).catch((error: unknown) => {
    if (final(error)) throw error;
    return undefined;
  });
  const usable = await consumeTwin(twin, logical, label, consume);
  if (usable) {
    void dispose(held.body);
    return usable.value;
  }
  // With no usable twin the logical bytes go on to verification, which names what is wrong with them.
  return consume(held);
}

/** The twin consumed, or undefined when it is missing, empty or does not decode. Cancellation stays final. */
async function consumeTwin<T>(twin: Response | undefined, logical: Miss, label: string, consume: (artifact: Artifact) => Promise<T>): Promise<{ value: T } | undefined> {
  if (!twin?.ok || !twin.body) {
    await dispose(twin?.body);
    return undefined;
  }
  try {
    return { value: await consume(gzipArtifact(twin, logical, label)) };
  } catch (error) {
    if (final(error)) throw error;
    return undefined;
  }
}

/** Discarding a body is best-effort: its own late error must not replace the result in hand. */
async function dispose(body: ReadableStream | null | undefined): Promise<void> {
  if (body) await body.cancel().catch(() => {});
}

/** The logical URL consumed, or why the `.gz` twin should be tried. Cancellation and compile errors stay final. */
async function attempt<T>(href: string, consume: (artifact: Artifact) => Promise<T>): Promise<{ value: T } | Miss> {
  try {
    const response = await fetch(href);
    if (!response.ok || !response.body) {
      await dispose(response.body);
      return { status: response.ok ? 404 : response.status };
    }
    const { body, wasm } = await replayHead(response.body);
    const artifact = { response, body, gzipped: false };
    // A single-page host can answer a missing file with its index page, whatever its content type.
    if (!wasm) return { status: 404, held: artifact };
    return { value: await consume(artifact) };
  } catch (error) {
    if (final(error)) throw error;
    return { status: 0, error };
  }
}

function final(error: unknown): boolean {
  if (error instanceof WebAssembly.CompileError) return true;
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

const WASM_MAGIC = [0, 0x61, 0x73, 0x6d];

/** The body with its first bytes read and replayed, and whether they start a WebAssembly module. */
async function replayHead(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{ body: ReadableStream<Uint8Array<ArrayBuffer>>; wasm: boolean }> {
  const reader = body.getReader();
  const head: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  while (length < WASM_MAGIC.length) {
    const { value, done } = await reader.read();
    if (done) break;
    head.push(value);
    length += value.length;
  }
  const prefix = head.flatMap(chunk => Array.from(chunk.subarray(0, WASM_MAGIC.length))).slice(0, WASM_MAGIC.length);
  const replayed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { for (const chunk of head) controller.enqueue(chunk); },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { body: replayed, wasm: WASM_MAGIC.every((byte, index) => prefix[index] === byte) };
}

/**
 * The `.gz` twin. When it is unusable too, the logical URL's interruption or own HTTP failure is the
 * better report, so a network failure is never mistaken for a missing asset.
 */
function gzipArtifact(response: Response, logical: Miss, label: string): Artifact {
  if (response.ok) return { response, body: requireBody(response, label), gzipped: true };
  if (logical.error !== undefined) throw logical.error;
  const status = response.status === 404 && logical.status !== 406 ? logical.status : response.status;
  if (status === 404) throw new WasmMissing(`${label}: HTTP 404`);
  throw new Error(`${label}: HTTP ${status}`);
}

function requireBody(response: Response, label: string): ReadableStream<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error(`${label}: empty response body`);
  return response.body;
}

/**
 * The byte count the progress counter will reach, or 0 when unknown. With a native Content-Encoding
 * the body yields decoded bytes while Content-Length counts the encoded ones, so only the host's
 * decoded size (web/serve.ts) is usable. The page counts a `.gz` twin before gunzipping it.
 */
function streamedLength(response: Response, gzipped: boolean): number {
  const decoded = Number(response.headers.get("x-uncompressed-length"));
  if (!gzipped && decoded > 0) return decoded;
  if (!gzipped && response.headers.get("content-encoding")) return 0;
  return Number(response.headers.get("content-length")) || 0;
}

/** Compiles a build-checked cache entry; null (and evicted) when its bytes do not compile. */
async function loadCachedWasm(url: string, key: string, cached: Response, build: string, progress: (text: string) => void) {
  progress("compiling cached bun.wasm…");
  const started = performance.now();
  const compiled = await compileCached(cached, key);
  if (!compiled) return null;
  const { bytes, module } = compiled;
  performance.mark("bunwasm:engine-cache-hit");
  measureStartup("compile", started, { cached: true });
  const kind = programKind(module);
  if (kind !== "single") return loadProgramSide(url, kind, { bytes, build }, progress, false);
  return { module, size: bytes.length, build };
}

async function compileCached(response: Response, key: string) {
  try {
    // Streaming compiles while the stored bytes are still being read.
    const copy = response.clone();
    const [module, bytes] = await Promise.all([
      observeCompile("core", () => WebAssembly.compileStreaming(new Response(copy.body, { headers: { "content-type": "application/wasm" } }))),
      response.arrayBuffer().then(buffer => new Uint8Array(buffer)),
    ]);
    recordProgramMemory(module, bytes);
    return { bytes, module };
  } catch {
    await evictEngine(key);
    return null;
  }
}

async function loadPaired(url: string, expected: PairedEngine, progress: (text: string) => void, memoryProfile?: ProgramMemoryProfile) {
  const core = loadVerifiedFile(url, profileAsset(programProfile(expected).core, memoryProfile ?? "split"), progress, true, memoryProfile);
  // Preparation compiles asynchronously and rejects a core that declares another engine.
  const loaded = await loadProgramSide(url, expected, core, progress, true, memoryProfile);
  verifyMemoryProfile(loaded.module, memoryProfile ?? "split");
  return loaded;
}

async function loadProgramSide(url: string, kind: PairedEngine, core: Awaited<ReturnType<typeof loadVerifiedFile>> | ReturnType<typeof loadVerifiedFile>, progress: (text: string) => void, verifyBuild: boolean, memoryProfile?: ProgramMemoryProfile) {
  const profile = programProfile(kind);
  if (kind === "spidermonkey" && !verifyBuild) {
    core = await core;
    const build = assetBuild(profile.core);
    if (build === null) throw new Error(`${profile.core}: build manifest fingerprint is missing`);
    await verifyArtifact(profile.core, core.bytes, build);
    core = { bytes: core.bytes, build };
    verifyBuild = true;
  }
  const sideUrl = new URL(profile.side, new URL(url, location.href));
  const [loadedCore, side] = await Promise.all([core, loadVerifiedFile(sideUrl.href, profileAsset(profile.side, memoryProfile ?? "split"), progress, verifyBuild, memoryProfile)]);
  const preparing = performance.now();
  const module = await withoutCompileSpans(() => prepareProgram({ kind, core: loadedCore.bytes, side: side.bytes }));
  measureStartup("prepare", preparing, { kind });
  return { module, size: loadedCore.bytes.length + side.bytes.length, build: loadedCore.build };
}

async function loadVerifiedTools(url: string, progress: (text: string) => void): Promise<{ module: WebAssembly.Module; size: number; build: string }> {
  const { bytes, build } = await loadVerifiedFile(url, "bun-tools.wasm", progress);
  if (build === null) throw new Error("bun-tools.wasm: build manifest fingerprint is missing");
  return { module: await prepareProgram({ kind: "single", core: bytes }), size: bytes.length, build };
}

async function loadVerifiedFile(url: string, name: string, progress: (text: string) => void, verifyBuild = true, memoryProfile?: ProgramMemoryProfile): Promise<{ bytes: Uint8Array<ArrayBuffer>; build: string | null }> {
  const build = verifyBuild ? assetBuild(name) : null;
  if (verifyBuild && build === null) throw new Error(`${name}: build manifest fingerprint is missing`);
  const requested = new URL(url, location.href);
  if (memoryProfile === "shared-group") requested.searchParams.set("profile", memoryProfile);
  const key = requested.href;
  const lookup = performance.now();
  const cached = build === null ? null : await cachedEngine(key, build);
  measureStartup("cache-lookup", lookup, { name, hit: cached !== null });
  if (cached && build !== null) return readVerifiedCache(key, name, cached, build, progress);
  const downloading = performance.now();
  progress(`downloading ${name}…`);
  let downloaded: Awaited<ReturnType<typeof downloadBytes>>;
  try {
    downloaded = await downloadBytes(requested.href, build, url);
  } catch (error) {
    // Headers or body failed: build-checked cached bytes still serve. A missing asset stays missing,
    // and verification below stays outside, so an integrity mismatch is never masked.
    const stored = build === null || error instanceof WasmMissing ? null : await cachedEngine(key, build, true);
    if (stored && build !== null) return readVerifiedCache(key, name, stored, build, progress);
    throw error;
  }
  const { bytes, gzipped } = downloaded;
  measureStartup("download", downloading, { name, bytes: bytes.length, gzipped });
  const verifying = performance.now();
  if (build !== null) await verifyArtifact(name, bytes, build);
  else verifyWasm(name, bytes);
  measureStartup("verify", verifying, { name, cached: false });
  progress(`verified ${name} (${mb(bytes.length)})…`);
  if (build !== null) {
    void cacheEngine(key, build, new Response(bytes, { headers: { "content-type": "application/wasm", "content-length": String(bytes.length) } })).then(stored => {
      if (stored) performance.mark("bunwasm:engine-cache-stored", { detail: { url: key, build } });
    });
  }
  return { bytes, build };
}

/** The whole artifact, gunzipped here when the host only had the `.gz` twin. */
async function downloadBytes(url: string, build: string | null, label: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; gzipped: boolean }> {
  return fromArtifact(url, build, label, async ({ body, gzipped }) => {
    const decoded = gzipped ? body.pipeThrough(new DecompressionStream("gzip")) : body;
    return { bytes: new Uint8Array(await new Response(decoded).arrayBuffer()), gzipped };
  });
}

/** Cached bytes count only after the same digest check as a download; a mismatch is evicted. */
async function readVerifiedCache(key: string, name: string, cached: Response, build: string, progress: (text: string) => void): Promise<{ bytes: Uint8Array<ArrayBuffer>; build: string }> {
  const reading = performance.now();
  const bytes = new Uint8Array(await cached.arrayBuffer());
  measureStartup("cache-read", reading, { name, bytes: bytes.length });
  const verifying = performance.now();
  try { await verifyArtifact(name, bytes, build); }
  catch (error) { await evictEngine(key); throw error; }
  measureStartup("verify", verifying, { name, cached: true });
  progress(`verified cached ${name} (${mb(bytes.length)})…`);
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
async function cacheIfExpected(key: string, build: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== build) return;
  const headers = { "content-type": "application/wasm", "content-length": String(bytes.byteLength) };
  // The snapshot is immutable after verification. A stream avoids Response(BufferSource)
  // making another full copy while cache storage consumes these already-owned bytes.
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  await cacheEngine(key, build, new Response(body, { headers }));
}

// The service worker at ./__bunwasm/ (sw.ts) serves the Bun worker's script with the headers a
// cross-origin isolated worker needs. Guest modules never depend on it (module-records.ts).
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
