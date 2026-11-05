import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { LoadedObservation } from "./c1/loaded.ts";

interface BytesIdentity { readonly sha256: string; readonly bytes: number }
export interface LoadedAsset extends BytesIdentity {
  readonly role: "loaded";
  readonly path: string;
  readonly encoding: "plain" | "gzip";
  readonly payload: BytesIdentity;
}
interface ResponseBytes { url(): string; status(): number; headers(): Record<string, string>; request(): { method(): string }; body(): Promise<Uint8Array> }

function httpEncoding(value: string | undefined): LoadedObservation["encoding"] {
  if (value === undefined || value === "identity") return "identity";
  if (value === "gzip" || value === "br") return value;
  throw new Error(`Unsupported response Content-Encoding: ${value}`);
}

function identity(bytes: Uint8Array): BytesIdentity {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

export function isLoadedAsset(url: string): boolean {
  return /\.(?:wasm|m?js)(?:\.gz)?$/.test(new URL(url).pathname);
}

export function expectedBrowserPayload(webRoot: string, read: (path: string) => Uint8Array = readFileSync): BytesIdentity {
  const plain = join(webRoot, "bun-browser.wasm");
  if (existsSync(plain)) return identity(read(plain));
  return identity(gunzipSync(read(`${plain}.gz`)));
}

/** Observe response bodies and explicit gzip payloads, not physical transport packets. */
export function loadedObserver(browserUrl: string, expected: BytesIdentity, guard: (url: string) => void = () => {}) {
  const assets: LoadedAsset[] = [];
  const loaded: LoadedObservation[] = [];
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  function capture(response: ResponseBytes): void {
    const path = response.url();
    const status = response.status();
    if (status < 200 || status >= 300) return;
    const method = response.request().method();
    if (status !== 200 || method !== "GET") { errors.push(new Error("Loaded code was not a successful GET 200")); return; }
    const task = Promise.resolve().then(() => { guard(path); return response.body(); }).then(bytes => {
      guard(path);
      const transport = httpEncoding(response.headers()["content-encoding"]);
      const encoding = new URL(path).pathname.endsWith(".gz") ? "gzip" : "plain";
      const payload = encoding === "gzip" ? gunzipSync(bytes) : bytes;
      const received = identity(bytes);
      assets.push({ role: "loaded", path, encoding, ...received, payload: encoding === "gzip" ? identity(payload) : received });
      loaded.push({ url: path, method, status, encoding: transport, ...received });
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
  async function finish(): Promise<{ readonly loaded: readonly LoadedObservation[]; readonly payloads: readonly LoadedAsset[] }> {
    await flush();
    const selected = assets.filter(asset => asset.path === browserUrl || asset.path === `${browserUrl}.gz` || asset.path.startsWith(`${browserUrl}?`) || asset.path.startsWith(`${browserUrl}.gz?`));
    if (!selected.length) throw new Error("Selected Browser guest was not observed");
    const mismatch = selected.some(asset => asset.payload.sha256 !== expected.sha256 || asset.payload.bytes !== expected.bytes);
    if (mismatch) throw new Error("Selected Browser guest bytes differ from supplied web root");
    return { loaded, payloads: assets };
  }
  return { capture, flush, finish };
}
