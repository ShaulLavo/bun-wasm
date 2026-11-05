import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

interface BytesIdentity { readonly sha256: string; readonly bytes: number }
export interface LoadedAsset extends BytesIdentity {
  readonly role: "loaded";
  readonly path: string;
  readonly encoding: "plain" | "gzip";
  readonly payload: BytesIdentity;
}
interface ResponseBytes { url(): string; ok(): boolean; body(): Promise<Uint8Array> }

function identity(bytes: Uint8Array): BytesIdentity {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

export function isLoadedAsset(url: string): boolean {
  return /\.(?:wasm|m?js)(?:\.gz)?$/.test(new URL(url).pathname);
}

export function expectedBrowserPayload(webRoot: string): BytesIdentity {
  const plain = join(webRoot, "bun-browser.wasm");
  if (existsSync(plain)) return identity(readFileSync(plain));
  return identity(gunzipSync(readFileSync(`${plain}.gz`)));
}

/** Observe response bodies and explicit gzip payloads, not physical transport packets. */
export function loadedObserver(browserUrl: string, expected: BytesIdentity) {
  const assets: LoadedAsset[] = [];
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  function capture(response: ResponseBytes): void {
    const path = response.url();
    if (!isLoadedAsset(path) || !response.ok()) return;
    const task = response.body().then(bytes => {
      const encoding = new URL(path).pathname.endsWith(".gz") ? "gzip" : "plain";
      const payload = encoding === "gzip" ? gunzipSync(bytes) : bytes;
      assets.push({ role: "loaded", path, encoding, ...identity(bytes), payload: identity(payload) });
    }).catch(error => { errors.push(error); });
    pending.push(task);
  }
  async function flush(): Promise<void> {
    let count = -1;
    while (count !== pending.length) {
      count = pending.length;
      await Promise.all(pending);
    }
    if (errors.length) throw new Error(`Loaded asset evidence failed: ${String(errors[0])}`);
  }
  async function finish(): Promise<readonly LoadedAsset[]> {
    await flush();
    const selected = assets.filter(asset => asset.path === browserUrl || asset.path === `${browserUrl}.gz` || asset.path.startsWith(`${browserUrl}?`) || asset.path.startsWith(`${browserUrl}.gz?`));
    if (!selected.length) throw new Error("Selected Browser guest was not observed");
    const mismatch = selected.some(asset => asset.payload.sha256 !== expected.sha256 || asset.payload.bytes !== expected.bytes);
    if (mismatch) throw new Error("Selected Browser guest bytes differ from supplied web root");
    return assets;
  }
  return { capture, flush, finish };
}
