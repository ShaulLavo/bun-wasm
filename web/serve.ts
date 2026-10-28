// Local preview of web/dist. Sends COOP/COEP so the page is cross-origin isolated
// (SharedArrayBuffer + Atomics.wait for sleeps). ISOLATE=0 previews the busy-wait fallback.
// ROOT=<dir> serves another build (the sandbox: `ROOT=dist bun ../web/serve.ts`).
// Cache-Control follows the build's _headers, as on Cloudflare. LATENCY_MS=<n> delays every
// response by n milliseconds, to measure what network round trips cost a remote user.
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
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
    // .wasm files may be published only as their .gz twin (Mesh apps cap source size).
    const gz = Bun.file(join(root, `${path}.gz`));
    if (path.endsWith(".wasm") && (await gz.exists())) {
      if (isolate) {
        headers["cross-origin-opener-policy"] = "same-origin";
        headers["cross-origin-embedder-policy"] = "require-corp";
      }
      headers["content-type"] = "application/wasm";
      if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
        return new Response(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())), { headers });
      }
      // gzip's trailer holds the uncompressed size (mod 2^32), for the progress bar.
      const trailer = new DataView(await gz.slice(gz.size - 4).arrayBuffer());
      headers["content-encoding"] = "gzip";
      headers["x-uncompressed-length"] = String(trailer.getUint32(0, true));
      return new Response(gz, { headers });
    }
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    if (isolate) {
      headers["cross-origin-opener-policy"] = "same-origin";
      headers["cross-origin-embedder-policy"] = "require-corp";
    }
    return new Response(file, { headers });
  },
});
console.log(`serving ${root} at ${server.url} (${isolate ? "cross-origin isolated" : "not isolated"})`);


let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  return stopping ??= (async () => { await previewOwner.close(); await server.stop(true); })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void stop().finally(() => process.exit()); });
