// Local preview of web/dist. Sends COOP/COEP so the page is cross-origin isolated
// (SharedArrayBuffer + Atomics.wait for sleeps). ISOLATE=0 previews the busy-wait fallback.
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "dist");
const isolate = process.env.ISOLATE !== "0";
const port = Number(process.env.PORT ?? 4173);

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    if (isolate) {
      headers["cross-origin-opener-policy"] = "same-origin";
      headers["cross-origin-embedder-policy"] = "require-corp";
    }
    return new Response(file, { headers });
  },
});
console.log(`serving ${root} at ${server.url} (${isolate ? "cross-origin isolated" : "not isolated"})`);
