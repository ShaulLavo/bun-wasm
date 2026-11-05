import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tlsPagePaths } from "../producer-closure.ts";
import { parseDelivery, type ConsumerHandoff, type HandoffRole, type MemberIdentity } from "./contract.ts";
import { fileIdentity, requireTreeInventory, sameBytes, sha256 } from "./identity.ts";

/**
 * What a Chromium consumer actually received, recorded by that consumer from
 * real responses (never precomputed). One row per GET response the page or
 * its workers loaded. `bytes`/`sha256` describe the body the page received
 * after browser decoding; `encoding` is the response Content-Encoding.
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
  /** Absolute admitted file whose identity the row matched; absent only for control rows. */
  readonly member?: string;
}
/** Which page served the rows: the delivered web root (five-owner) or the delivered TLS page (TLS). */
export type LoadedSurface = "web" | "tls";

class LoadedError extends Error {}
function fail(message: string): never { throw new LoadedError(message); }
const ENCODINGS: readonly string[] = ["identity", "gzip", "br"];

export function parseLoaded(value: unknown): LoadedObservation[] {
  if (!Array.isArray(value)) fail("result has no top-level loaded array");
  return value.map((row, index) => {
    const label = `loaded[${index}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`${label} is not an object`);
    const fields = row as Record<string, unknown>;
    const keys = Object.keys(fields).sort().join(",");
    if (keys !== "bytes,encoding,method,sha256,status,url") fail(`${label} must have exactly url, method, status, encoding, bytes and sha256`);
    const { url, method, status, encoding, bytes, sha256: digest } = fields;
    if (typeof url !== "string" || method !== "GET" || status !== 200 || typeof encoding !== "string" || !ENCODINGS.includes(encoding)) fail(`${label} is not a successful GET observation`);
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail(`${label} has no body identity`);
    return { url, method: "GET", status: 200, encoding: encoding as LoadedObservation["encoding"], bytes, sha256: digest };
  });
}

/** The sealed delivery's own member inventory, read only from the DELIVERY.json the handoff pins. */
class Admitted {
  readonly members: ReadonlyMap<string, MemberIdentity>;
  private pg: { readonly root: string; readonly files: ReadonlyMap<string, { readonly bytes: number; readonly sha256: string }> } | undefined;
  constructor(readonly handoff: ConsumerHandoff) {
    const manifest = handoff.delivery.manifest;
    if (!sameBytes(fileIdentity(manifest.path), manifest)) fail("DELIVERY.json differs from the one the handoff pins");
    this.members = new Map(parseDelivery(JSON.parse(readFileSync(manifest.path, "utf8"))).files.map(file => [file.path, file]));
  }
  /** Bytes of a sealed member, refused unless they are still exactly what DELIVERY.json lists. */
  bytes(member: string): Buffer {
    const listed = this.members.get(member) ?? fail(`${member} is not an admitted member`);
    const bytes = readFileSync(join(this.handoff.delivery.root, member));
    if (bytes.byteLength !== listed.bytes || sha256(bytes) !== listed.sha256) fail(`${member} changed since sealing`);
    return bytes;
  }
  /** The admitted pg tree, proven unchanged in the same walk that lists it. */
  pgFiles() {
    const tls = this.handoff.dependencies.tls;
    if (tls.status !== "resolved") fail("pg dependencies were never admitted");
    this.pg ??= { root: tls.value.pgModules.path, files: requireTreeInventory(tls.value.pgModules, "pg dependency") };
    return this.pg;
  }
}

function matches(row: LoadedObservation, bytes: Uint8Array): boolean { return bytes.byteLength === row.bytes && sha256(bytes) === row.sha256; }
function identityOnly(row: LoadedObservation): void {
  if (row.encoding !== "identity") fail(`${row.url} arrived ${row.encoding}-encoded but no admitted ${row.encoding} representation exists: that route only serves raw admitted bytes`);
}
/** The request path below the page root; dot segments, backslashes and encoded dots were refused before URL parsing. */
function requestPath(pathname: string): string {
  const path = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (path.split("/").some(part => part === "." || part === "..")) fail(`${pathname} leaves its admitted root`);
  return path === "" || path.endsWith("/") ? `${path}index.html` : path;
}
/**
 * web/serve.ts semantics: a `.wasm` path is answered from its raw, `.gz` or
 * `.br` member, and identity falls back raw, then gzip, then br, decoded by
 * the server. Every other path is the raw member itself.
 */
function bindWeb(admitted: Admitted, path: string, row: LoadedObservation): LoadedBinding {
  const member = `split/web/${path}`;
  if (!path.endsWith(".wasm")) {
    identityOnly(row);
    if (!matches(row, admitted.bytes(member))) fail(`${row.url} bytes differ from the admitted member`);
    return { url: row.url, route: "web", member: join(admitted.handoff.delivery.root, member) };
  }
  const variants = ([["identity", ""], ["gzip", ".gz"], ["br", ".br"]] as const).filter(([, suffix]) => admitted.members.has(member + suffix));
  if (!variants.length) fail(`${row.url} is not an admitted member`);
  const [chosen] = row.encoding === "identity" ? variants : variants.filter(([encoding]) => encoding === row.encoding);
  if (!chosen) fail(`${row.url} arrived ${row.encoding}-encoded but no admitted ${row.encoding} representation exists`);
  const raw = admitted.bytes(member + chosen[1]);
  const decoded = chosen[0] === "identity" ? raw : chosen[0] === "gzip" ? gunzipSync(raw) : brotliDecompressSync(raw);
  if (!matches(row, decoded)) fail(`${row.url} bytes differ from the admitted member`);
  return { url: row.url, route: "web", member: join(admitted.handoff.delivery.root, member + chosen[1]) };
}
const GUEST_ROLES: readonly HandoffRole[] = ["browserGuest", "quickjsGuest", "quickjsSide", "jscGuest", "jscSide"];
function bindTls(admitted: Admitted, pathname: string, row: LoadedObservation): LoadedBinding {
  identityOnly(row);
  const { handoff } = admitted;
  if (pathname === "/seed") return { url: row.url, route: "control" };
  if (pathname === "/pg-client.ts") {
    if (!matches(row, admitted.bytes(tlsPagePaths.pgClient))) fail(`${row.url} bytes differ from the admitted pg client`);
    return { url: row.url, route: "tls-fixture", member: handoff.artifacts.tlsPgClient.path };
  }
  const artifact = /^\/artifact\/([a-f0-9]{64})$/.exec(pathname)?.[1];
  if (artifact) {
    const role = GUEST_ROLES.find(candidate => handoff.artifacts[candidate].sha256 === artifact);
    if (!role || artifact !== row.sha256 || handoff.artifacts[role].bytes !== row.bytes) fail(`${row.url} is not the admitted guest it names`);
    return { url: row.url, route: "guest-artifact", member: handoff.artifacts[role].path };
  }
  if (pathname.startsWith("/seed/node_modules/")) {
    const path = requestPath(pathname.slice("/seed/node_modules/".length));
    const { root, files } = admitted.pgFiles();
    const file = files.get(path) ?? fail(`${row.url} is not a file of the admitted pg tree`);
    if (row.bytes !== file.bytes || row.sha256 !== file.sha256) fail(`${row.url} bytes differ from the admitted pg tree`);
    return { url: row.url, route: "pg-seed", member: join(root, path) };
  }
  const member = `${tlsPagePaths.root}/${requestPath(pathname)}`;
  if (!matches(row, admitted.bytes(member))) fail(`${row.url} bytes differ from the admitted member`);
  return { url: row.url, route: "tls-page", member: join(handoff.delivery.root, member) };
}

/** The one page origin: plain HTTP on loopback, with the TLS page on its configured port. */
function pageOrigin(handoff: ConsumerHandoff, surface: LoadedSurface, rows: readonly LoadedObservation[]): void {
  const origins = new Set(rows.map(row => new URL(row.url).origin));
  const [origin] = origins;
  if (origins.size !== 1 || !origin) fail("loaded rows must all come from one loopback page origin");
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) fail(`${origin} is not a loopback HTTP page origin`);
  const tls = handoff.fixtures.tls;
  if (surface === "tls" && tls.status === "resolved" && Number(url.port) !== tls.value.pagePort) fail(`${origin} is not the configured TLS page port`);
}
/** The objects each surface must actually have loaded for its result to describe the selected execution. */
function requireCoverage(handoff: ConsumerHandoff, surface: LoadedSurface, bound: readonly LoadedBinding[]): void {
  const members = new Set(bound.map(binding => binding.member));
  const at = (member: string) => join(handoff.delivery.root, member);
  const guest = surface === "web" ? ["", ".gz", ".br"].map(suffix => at(`split/web/bun-browser.wasm${suffix}`)) : [handoff.artifacts.browserGuest.path];
  if (!guest.some(member => members.has(member))) fail(`the ${surface} consumer loaded no WebAssembly Browser guest (${guest[0]})`);
  const required = surface === "web" ? [at("split/web/index.html"), at("split/web/worker.js")] : [at(tlsPagePaths.index), at(tlsPagePaths.entry), at(`${tlsPagePaths.root}/fs-worker.js`)];
  const missing = required.filter(member => !members.has(member));
  if (missing.length) fail(`the ${surface} consumer did not load ${missing.join(", ")}`);
}

/**
 * Bind every observed response to an admitted object: sealed delivery
 * members by the pinned DELIVERY.json, the Browser guest by role, pg seeds by
 * the admitted tree inventory. Any unbound, foreign-origin, mismatched or
 * misencoded row refuses the whole result, as does missing coverage of the
 * selected execution's page, worker and Browser guest.
 */
export function bindLoaded(handoff: ConsumerHandoff, surface: LoadedSurface, rows: readonly LoadedObservation[]): LoadedBinding[] {
  pageOrigin(handoff, surface, rows);
  for (const row of rows) if (/\/\.{1,2}(?:\/|$)|%2e|\\/i.test(row.url.slice(row.url.indexOf("//") + 2))) fail(`${row.url} uses a dot segment, encoded dot or backslash`);
  const admitted = new Admitted(handoff);
  const bound = rows.map(row => {
    const { pathname } = new URL(row.url);
    return surface === "web" ? bindWeb(admitted, requestPath(pathname), row) : bindTls(admitted, pathname, row);
  });
  requireCoverage(handoff, surface, bound);
  return bound;
}
