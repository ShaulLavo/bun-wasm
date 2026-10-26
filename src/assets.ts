import { prepareLinkPlan, type LinkPlanSource } from "waffle/link";
import { quickjsProgramSource } from "./quickjs-program.js";
import { BUN_WASM_ASSET } from "./guest-asset.generated.js";
export { BUN_WASM_ASSET } from "./guest-asset.generated.js";

/** Immutable guest metadata. The SHA-256 and byte count cover decompressed Wasm bytes. */
export interface BunWasmFile {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BunWasmAsset extends BunWasmFile {
  readonly quickjs?: BunWasmFile;
}

export class BunWasmAssetError extends Error {
  readonly code = "BUN_WASM_ASSET_INVALID";
  constructor(message: string) { super(message); this.name = "BunWasmAssetError"; }
}

export interface LoadBunWasmOptions {
  /** Compiled module for tests or offline hosts; no network access is made. */
  readonly module?: WebAssembly.Module;
  /** Exact URL override; the selected asset's integrity expectations still apply. */
  readonly wasmUrl?: string | URL;
  readonly asset?: BunWasmAsset;
  readonly fetch?: (url: string) => Promise<Response>;
}

const COMPRESSED_SIZE_MARGIN = 64 * 1024;

type LimitedBody = {
  stream: ReadableStream<Uint8Array<ArrayBuffer>>;
  prefix: Uint8Array<ArrayBuffer>;
};

/**
 * Read only enough of a response to identify its encoding, then continue streaming it while
 * enforcing a compressed-size ceiling. The body itself is never buffered in full.
 */
async function openLimitedBody(response: Response, limit: number): Promise<LimitedBody> {
  if (!response.body) throw new BunWasmAssetError("Guest response has no body");
  const reader = response.body.getReader();
  const initial: Uint8Array<ArrayBuffer>[] = [];
  let compressedBytes = 0;
  let finished = false;

  const readChunk = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
    const result = await reader.read();
    if (result.done) {
      finished = true;
      reader.releaseLock();
      return null;
    }
    compressedBytes += result.value.byteLength;
    if (compressedBytes > limit) {
      try { await reader.cancel(); } finally {
        finished = true;
        reader.releaseLock();
      }
      throw new BunWasmAssetError(`Guest response exceeds the compressed size limit of ${limit} bytes`);
    }
    return new Uint8Array(result.value);
  };

  try {
    let prefixLength = 0;
    while (prefixLength < 2) {
      const chunk = await readChunk();
      if (chunk === null) break;
      if (chunk.byteLength === 0) continue;
      initial.push(chunk);
      prefixLength += chunk.byteLength;
    }
    const prefix = new Uint8Array(Math.min(2, initial.reduce((total, chunk) => total + chunk.byteLength, 0)));
    let offset = 0;
    for (const chunk of initial) {
      const length = Math.min(chunk.byteLength, prefix.length - offset);
      if (length <= 0) break;
      prefix.set(chunk.subarray(0, length), offset);
      offset += length;
    }

    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const chunk of initial) controller.enqueue(chunk);
        if (finished) controller.close();
      },
      async pull(controller) {
        if (finished) {
          controller.close();
          return;
        }
        try {
          const chunk = await readChunk();
          if (chunk === null) controller.close();
          else controller.enqueue(chunk);
        } catch (error) {
          if (!finished) {
            try { await reader.cancel(error); } catch { /* preserve the read failure */ }
            finally {
              finished = true;
              reader.releaseLock();
            }
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (finished) return;
        try { await reader.cancel(reason); }
        finally {
          finished = true;
          reader.releaseLock();
        }
      },
    });
    return { stream, prefix };
  } catch (error) {
    if (!finished) {
      try { await reader.cancel(error); }
      finally {
        finished = true;
        reader.releaseLock();
      }
    }
    throw error;
  }
}

async function readLimited(stream: ReadableStream<Uint8Array<ArrayBuffer>>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      length += result.value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new BunWasmAssetError(`Guest byte count exceeds the declared size of ${limit} bytes`);
      }
      chunks.push(new Uint8Array(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const programs = new WeakMap<WebAssembly.Module, LinkPlanSource>();

export async function prepareQuickjsProgram(core: Uint8Array, quickjs: Uint8Array): Promise<WebAssembly.Module> {
  const plan = await prepareLinkPlan(await quickjsProgramSource(core, quickjs));
  programs.set(plan.entryModule, plan.toSource());
  return plan.entryModule;
}

export function programLinkPlan(module: WebAssembly.Module): LinkPlanSource | undefined {
  const plan = programs.get(module);
  if (!plan && WebAssembly.Module.exports(module).some(entry => entry.name === "bun_core_bind_engine")) {
    throw new BunWasmAssetError("QuickJS core requires its matching prepared side module");
  }
  return plan;
}

export async function loadBunWasm(options: LoadBunWasmOptions = {}): Promise<WebAssembly.Module> {
  if (options.module) {
    programLinkPlan(options.module);
    return options.module;
  }
  const asset = options.asset ?? BUN_WASM_ASSET;
  if (!asset) throw new BunWasmAssetError("No matching Bun guest has been published; provide asset or module");
  const core = { url: options.wasmUrl?.toString() ?? asset.url, sha256: asset.sha256, bytes: asset.bytes };
  const side = asset.quickjs ? { ...asset.quickjs } : undefined;
  const fetch = options.fetch ?? globalThis.fetch;
  const bytes = await loadFile(core, fetch);
  if (side) return prepareQuickjsProgram(bytes, await loadFile(side, fetch));
  const module = await WebAssembly.compile(bytes);
  programLinkPlan(module);
  return module;
}

/** Verify before compilation so a changed CDN response cannot execute as the expected guest. */
async function loadFile(asset: BunWasmFile, fetch: (url: string) => Promise<Response>): Promise<Uint8Array<ArrayBuffer>> {
  const { url, sha256: expectedHash, bytes: expectedBytes } = asset;
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 8) {
    throw new BunWasmAssetError("Guest descriptor requires a SHA-256 hash and a valid byte count");
  }
  const response = await fetch(url);
  if (!response.ok) throw new BunWasmAssetError(`${url}: HTTP ${response.status}`);
  const limited = await openLimitedBody(response, expectedBytes + COMPRESSED_SIZE_MARGIN);
  const body = limited.prefix[0] === 0x1f && limited.prefix[1] === 0x8b
    ? limited.stream.pipeThrough(new DecompressionStream("gzip"))
    : limited.stream;
  const bytes = await readLimited(body, expectedBytes);
  if (bytes.length !== expectedBytes) throw new BunWasmAssetError(`Guest byte count mismatch: expected ${expectedBytes}, received ${bytes.length}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expectedHash) throw new BunWasmAssetError(`Guest SHA-256 mismatch: expected ${expectedHash}, received ${hash}`);
  return bytes;
}
