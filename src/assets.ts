import { prepareLinkPlan, type LinkPlanSource } from "waffle/link";
import { engineLinkPlan } from "./quickjs-program.ts";
import { parseProgramFiles, programKind, type ProgramFiles } from "./engine-kind.ts";
import { BUN_WASM_ASSET } from "./guest-asset.generated.ts";
export { BUN_WASM_ASSET } from "./guest-asset.generated.ts";

/** Immutable guest metadata. The SHA-256 and byte count cover decompressed Wasm bytes. */
export interface BunWasmFile {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type BunWasmAsset = ProgramFiles<BunWasmFile>;

export function parseBunWasmAsset(value: unknown): BunWasmAsset {
  return parseProgramFiles(value, file => {
    if (!file || typeof file !== "object" || !("url" in file) || typeof file.url !== "string"
      || !("sha256" in file) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !("bytes" in file) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 8) {
      throw new BunWasmAssetError("Guest descriptor requires a URL, SHA-256 hash and a valid byte count");
    }
    return { url: file.url, sha256: file.sha256, bytes: file.bytes };
  });
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

export async function prepareProgram(files: ProgramFiles<Uint8Array>): Promise<WebAssembly.Module> {
  if (files.kind === "single") {
    const module = await WebAssembly.compile(Uint8Array.from(files.core));
    if (programKind(module) !== "single") throw new BunWasmAssetError("Paired core requires its matching prepared side module");
    return module;
  }
  try {
    const plan = await prepareLinkPlan(await engineLinkPlan(files));
    programs.set(plan.entryModule, plan.toSource());
    return plan.entryModule;
  } catch (error) {
    if (error instanceof TypeError || error instanceof WebAssembly.CompileError) {
      throw new BunWasmAssetError(error.message);
    }
    throw error;
  }
}

/** Existing explicit QuickJS callers use the same strict preparation owner. */
export function prepareQuickjsProgram(core: Uint8Array, side: Uint8Array): Promise<WebAssembly.Module> {
  return prepareProgram({ kind: "quickjs", core, side });
}

export function programLinkPlan(module: WebAssembly.Module): LinkPlanSource | undefined {
  const plan = programs.get(module);
  if (!plan && programKind(module) !== "single") {
    throw new BunWasmAssetError("Paired core requires its matching prepared side module");
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
  const files = parseBunWasmAsset(asset);
  const core = { ...files.core, url: options.wasmUrl?.toString() ?? files.core.url };
  const fetch = options.fetch ?? globalThis.fetch;
  const bytes = await loadFile(core, fetch);
  if (files.kind !== "single") return prepareProgram({ kind: files.kind, core: bytes, side: await loadFile(files.side, fetch) });
  return prepareProgram({ kind: "single", core: bytes });
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
