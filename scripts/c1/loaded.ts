import { brotliDecompressSync } from "node:zlib";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ConsumerHandoff, HandoffRole } from "./contract.ts";
import { inside, sha256 } from "./identity.ts";

/**
 * What a Chromium consumer actually received, recorded by that consumer from
 * real responses (never precomputed). One row per GET response the page or
 * its workers loaded. `bytes`/`sha256` describe the decoded body the browser
 * handed the page; `encoding` is the response Content-Encoding.
 */
export interface LoadedObservation {
  readonly url: string;
  readonly method: "GET";
  readonly status: 200;
  readonly encoding: "identity" | "gzip" | "br";
  readonly bytes: number;
  readonly sha256: string;
}
/** The admitted object a row was bound to. Consumers never choose the route; the validator derives it from the URL. */
export interface LoadedBinding {
  readonly url: string;
  readonly route: "web" | "tls-page" | "guest-artifact" | "pg-seed" | "tls-fixture" | "control";
  /** Absolute admitted file whose decoded bytes the row matched; absent only for control rows. */
  readonly member?: string;
}
/** Which page served the rows: the delivered web root (five-owner) or the delivered TLS page (TLS). */
export type LoadedSurface = "web" | "tls";

class LoadedError extends Error {}
function fail(message: string): never { throw new LoadedError(message); }
const ENCODINGS = ["identity", "gzip", "br"];

export function parseLoaded(value: unknown): LoadedObservation[] {
  if (!Array.isArray(value)) fail("result has no top-level loaded array");
  return value.map((row, index) => {
    const label = `loaded[${index}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`${label} is not an object`);
    const fields = row as Record<string, unknown>;
    const keys = Object.keys(fields).sort().join(",");
    if (keys !== "bytes,encoding,method,sha256,status,url") fail(`${label} must have exactly url, method, status, encoding, bytes and sha256`);
    if (typeof fields.url !== "string" || fields.method !== "GET" || fields.status !== 200 || !ENCODINGS.includes(String(fields.encoding))) fail(`${label} is not a successful GET observation`);
    if (typeof fields.bytes !== "number" || !Number.isSafeInteger(fields.bytes) || fields.bytes < 0 || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) fail(`${label} has no decoded identity`);
    return { url: fields.url, method: "GET", status: 200, encoding: fields.encoding as LoadedObservation["encoding"], bytes: fields.bytes, sha256: fields.sha256 };
  });
}

/** Decoded bytes of the admitted representation web/serve.ts would answer `path` from: raw, `.gz` or `.br`. */
function representations(path: string): { encoding: LoadedObservation["encoding"]; decoded: Uint8Array }[] {
  const found: { encoding: LoadedObservation["encoding"]; decoded: Uint8Array }[] = [];
  if (existsSync(path) && lstatSync(path).isFile()) found.push({ encoding: "identity", decoded: readFileSync(path) });
  if (existsSync(`${path}.gz`)) found.push({ encoding: "gzip", decoded: Bun.gunzipSync(readFileSync(`${path}.gz`)) });
  if (existsSync(`${path}.br`)) found.push({ encoding: "br", decoded: brotliDecompressSync(readFileSync(`${path}.br`)) });
  return found;
}
function bindFile(root: string, pathname: string, row: LoadedObservation, route: LoadedBinding["route"]): LoadedBinding {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  const path = join(root, relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative);
  if (!inside(root, path) || relative.split("/").includes("..")) fail(`${row.url} leaves its admitted root`);
  const candidates = representations(path);
  const encoded = row.encoding === "identity" ? candidates : candidates.filter(candidate => candidate.encoding === row.encoding);
  if (!candidates.length) fail(`${row.url} is not an admitted member`);
  if (!encoded.length) fail(`${row.url} arrived ${row.encoding}-encoded but no admitted ${row.encoding} representation exists`);
  if (!encoded.some(candidate => candidate.decoded.byteLength === row.bytes && sha256(candidate.decoded) === row.sha256)) fail(`${row.url} bytes differ from the admitted member`);
  return { url: row.url, route, member: path };
}
const GUEST_ROLES: readonly HandoffRole[] = ["browserGuest", "quickjsGuest", "quickjsSide", "jscGuest", "jscSide"];
function bindTls(handoff: ConsumerHandoff, pathname: string, row: LoadedObservation): LoadedBinding {
  if (pathname === "/seed") return { url: row.url, route: "control" };
  if (pathname === "/pg-client.ts") return bindFile(handoff.artifacts.tlsPgClient.path.slice(0, -"/pg-client.ts".length), pathname, row, "tls-fixture");
  const artifact = /^\/artifact\/([a-f0-9]{64})$/.exec(pathname)?.[1];
  if (artifact) {
    const role = GUEST_ROLES.find(candidate => handoff.artifacts[candidate].sha256 === artifact);
    if (!role || artifact !== row.sha256 || handoff.artifacts[role].bytes !== row.bytes) fail(`${row.url} is not the admitted guest it names`);
    return { url: row.url, route: "guest-artifact", member: handoff.artifacts[role].path };
  }
  if (pathname.startsWith("/seed/node_modules/")) {
    const tls = handoff.dependencies.tls;
    if (tls.status !== "resolved") fail(`${row.url} loads pg dependencies that were never admitted`);
    return bindFile(tls.value.pgModules.path, pathname.slice("/seed/node_modules".length), row, "pg-seed");
  }
  return bindFile(handoff.tlsPageRoot, pathname, row, "tls-page");
}

/**
 * Bind every observed response to an admitted object. All rows must come
 * from one loopback origin; any row that maps nowhere, or whose decoded
 * bytes differ, refuses the whole result. At least one WebAssembly module
 * must have been loaded.
 */
export function bindLoaded(handoff: ConsumerHandoff, surface: LoadedSurface, rows: readonly LoadedObservation[]): LoadedBinding[] {
  const origins = new Set(rows.map(row => new URL(row.url).origin));
  const [origin] = origins;
  if (origins.size !== 1 || !origin || new URL(origin).hostname !== "127.0.0.1") fail("loaded rows must all come from one loopback page origin");
  const bound = rows.map(row => {
    const { pathname } = new URL(row.url);
    return surface === "web" ? bindFile(handoff.webRoot, pathname, row, "web") : bindTls(handoff, pathname, row);
  });
  if (!rows.some(row => /\.wasm(?:\.gz)?$|^\/artifact\//.test(new URL(row.url).pathname))) fail("the Browser consumer loaded no WebAssembly");
  return bound;
}
