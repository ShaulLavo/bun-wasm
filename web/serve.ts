// Local preview of web/dist. Sends COOP/COEP so the page is cross-origin isolated
// (SharedArrayBuffer + Atomics.wait for sleeps). ISOLATE=0 previews the busy-wait fallback.
// ROOT=<dir> serves another build (the sandbox: `ROOT=dist bun ../web/serve.ts`).
// Cache-Control follows the build's _headers, as on Cloudflare. LATENCY_MS=<n> delays every
// response by n milliseconds, to measure what network round trips cost a remote user.
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { PreviewOwnerHost } from "./scripts/preview-owner-host";

const root = process.env.ROOT ? resolve(process.env.ROOT) : join(import.meta.dir, "dist");
const isolate = process.env.ISOLATE !== "0";
const port = Number(process.env.PORT ?? 4173);
const latency = Number(process.env.LATENCY_MS ?? 0);
const cacheRules = readCacheRules(join(root, "_headers"));
const previewOwner = new PreviewOwnerHost();
const rootPreviews = process.env.PREVIEW_ORIGINS === "1";
if (rootPreviews && (process.env.HOST ?? "127.0.0.1") !== "127.0.0.1") throw new Error("Root previews require a loopback host");

/** The Cache-Control rules of a Cloudflare _headers file: a path pattern with at most one splat. */
function readCacheRules(path: string): { pattern: RegExp; value: string }[] {
  if (!existsSync(path)) return [];
  const rules: { pattern: RegExp; value: string }[] = [];
  let pattern: RegExp | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      pattern = new RegExp(`^${line.trim().split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      continue;
    }
    const header = /^\s+cache-control:\s*(.+)$/i.exec(line);
    if (header && pattern) rules.push({ pattern, value: header[1]!.trim() });
  }
  return rules;
}

/** Cloudflare joins the values of every matching rule with a comma. */
function cacheControl(pathname: string): string {
  const values = cacheRules.filter(rule => rule.pattern.test(pathname)).map(rule => rule.value);
  return values.length ? values.join(", ") : pathname.endsWith(".html") ? "no-store" : "no-cache";
}

type Encoding = "br" | "gzip" | "identity";
type Representation = { encoding: Encoding; file: ReturnType<typeof Bun.file> };

function acceptedEncodings(value: string | null): Encoding[] | undefined {
  if (!value?.trim()) return ["identity"];
  const weights = new Map<string, number>();
  for (const member of value.split(",")) {
    if (!member.trim()) continue;
    const match = /^([!#$%&'*+.^_`|~0-9a-z-]+)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/i.exec(member.trim());
    const token = match?.[1]?.toLowerCase();
    if (!token) return;
    const coding = token === "x-gzip" ? "gzip" : token;
    const weight = Number(match?.[2] ?? 1);
    weights.set(coding, Math.min(weights.get(coding) ?? 1, weight));
  }
  const preference: Encoding[] = ["br", "gzip", "identity"];
  const quality = (encoding: Encoding) => weights.get(encoding) ?? (encoding === "identity" ? 0 : weights.get("*") ?? 0);
  const accepted = preference.filter(encoding => quality(encoding) > 0);
  accepted.sort((first, second) => quality(second) - quality(first));
  // Unweighted identity is the fallback, unless identity or the wildcard refuses it.
  if (!weights.has("identity") && weights.get("*") !== 0) accepted.push("identity");
  return accepted;
}

async function wasmResponse(path: string, acceptEncoding: string | null, headers: Record<string, string>): Promise<Response> {
  headers["vary"] = "Accept-Encoding";
  const preference = acceptedEncodings(acceptEncoding);
  if (!preference) return new Response("invalid Accept-Encoding", { status: 400, headers });
  const available = new Map<Encoding, Representation>();
  const variants: { encoding: Encoding; suffix: string }[] = [
    { encoding: "br", suffix: ".br" }, { encoding: "gzip", suffix: ".gz" }, { encoding: "identity", suffix: "" },
  ];
  for (const { encoding, suffix } of variants) {
    const file = Bun.file(path + suffix);
    if (await file.exists()) available.set(encoding, { encoding, file });
  }
  const identity = available.get("identity") ?? available.get("gzip") ?? available.get("br");
  if (!identity) return new Response("not found", { status: 404, headers });
  available.set("identity", identity);
  headers["content-type"] = "application/wasm";
  for (const encoding of preference) {
    const source = available.get(encoding);
    if (source) return wasmRepresentation(encoding, source, headers);
  }
  return new Response(null, { status: 406, headers });
}

async function wasmRepresentation(encoding: Encoding, source: Representation, headers: Record<string, string>): Promise<Response> {
  if (encoding === "identity" && source.encoding !== "identity") {
    const bytes = new Uint8Array(await source.file.arrayBuffer());
    const body = source.encoding === "gzip" ? Bun.gunzipSync(bytes) : brotliDecompressSync(bytes);
    return new Response(body, { headers });
  }
  if (encoding !== "identity") headers["content-encoding"] = encoding;
  if (encoding === "gzip") {
    // gzip's trailer holds the uncompressed size (mod 2^32), for the progress bar.
    const trailer = new DataView(await source.file.slice(source.file.size - 4).arrayBuffer());
    headers["x-uncompressed-length"] = String(trailer.getUint32(0, true));
  }
  return new Response(source.file, { headers });
}

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  websocket: previewOwner.websocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (rootPreviews && previewOwner.handles(url.pathname)) return previewOwner.fetch(req, server);
    if (latency > 0) await Bun.sleep(latency);
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const headers: Record<string, string> = { "cache-control": cacheControl(url.pathname) };
    if (isolate) {
      headers["cross-origin-opener-policy"] = "same-origin";
      headers["cross-origin-embedder-policy"] = "require-corp";
    }
    if (path.endsWith(".wasm")) return wasmResponse(join(root, path), req.headers.get("accept-encoding"), headers);
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers });
  },
});
console.log(`serving ${root} at ${server.url} (${isolate ? "cross-origin isolated" : "not isolated"})`);


let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => { await previewOwner.close(); await server.stop(true); })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void stop().finally(() => process.exit()); });
