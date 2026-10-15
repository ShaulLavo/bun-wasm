// Local preview of web/dist. Sends COOP/COEP so the page is cross-origin isolated
// (SharedArrayBuffer + Atomics.wait for sleeps). ISOLATE=0 previews the busy-wait fallback.
// ROOT=<dir> serves another build (the sandbox: `ROOT=dist bun ../web/serve.ts`).
import { join, normalize, resolve } from "node:path";

const root = process.env.ROOT ? resolve(process.env.ROOT) : join(import.meta.dir, "dist");
const isolate = process.env.ISOLATE !== "0";
const port = Number(process.env.PORT ?? 4173);

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const headers: Record<string, string> = { "cache-control": "no-cache" };
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
