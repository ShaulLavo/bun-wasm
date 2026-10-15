import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function registry(options) {
  const { directory, record } = options;
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "record.lock");
  if (record) writeFileSync(lock, String(process.pid), { flag: "wx" });
  try { return await openMirror(options, () => { if (record) rmSync(lock); }); }
  catch (error) { if (record) rmSync(lock); throw error; }
}

async function openMirror({ directory, record }, release) {
  mkdirSync(join(directory, "objects"), { recursive: true });
  const manifestPath = join(directory, "index.json");
  const entries = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const pending = new Map();
  const requests = [];
  const misses = [];
  const errors = [];
  let base;

  async function load(path) {
    if (entries[path]) {
      const entry = entries[path];
      const bytes = readFileSync(join(directory, "objects", entry.sha256));
      if (sha256(bytes) !== entry.sha256) throw new Error(`Corrupt registry object ${path}`);
      return { ...entry, bytes };
    }
    if (!record) {
      misses.push(path);
      return { status: 503, type: "text/plain", bytes: Buffer.from(`Unrecorded registry request ${path}`) };
    }
    const url = new URL(path, "https://registry.npmjs.org");
    if (url.origin !== "https://registry.npmjs.org") throw new Error(`Invalid registry path ${path}`);
    const socket = process.env.MATRIX_RECORDER_SOCKET;
    if (!socket) throw new Error("Recording requires the isolated runner and upstream broker");
    const response = await fetch(`http://recorder${url.pathname}`, { unix: socket, headers: { accept: "application/vnd.npm.install-v1+json" }, redirect: "error", signal: AbortSignal.timeout(60000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const entry = { status: response.status, type: response.headers.get("content-type") ?? "application/octet-stream", sha256: sha256(bytes) };
    writeFileSync(join(directory, "objects", entry.sha256), bytes);
    entries[path] = entry;
    writeFileSync(`${manifestPath}.tmp`, JSON.stringify(entries, null, 2) + "\n");
    renameSync(`${manifestPath}.tmp`, manifestPath);
    return { ...entry, bytes };
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "cross-origin-resource-policy": "cross-origin" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const path = new URL(request.url).pathname;
      if (path.startsWith("/blocked-prisma-engines")) return new Response("Native Prisma engine downloads are disabled in this fixture", { status: 403, headers });
      requests.push(path);
      try {
        if (!pending.has(path)) pending.set(path, load(path));
        const entry = await pending.get(path);
        let bytes = entry.bytes;
        if (entry.type.includes("json")) bytes = Buffer.from(JSON.stringify(rewriteMetadata(JSON.parse(bytes.toString()), base)));
        return new Response(bytes, { status: entry.status, headers: { ...headers, "content-type": entry.type } });
      } catch (error) {
        errors.push(String(error));
        return new Response(String(error), { status: 502, headers });
      } finally { pending.delete(path); }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  return {
    base, requests, misses, errors,
    snapshot: () => ({ entries: Object.keys(entries).length, sha256: sha256(JSON.stringify(entries)), requests: requests.length, misses, errors }),
    async close() { await server.stop(true); release(); },
  };
}

export function rewriteMetadata(value, base) {
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "tarball") { value[key] = rewriteMetadata(child, base); continue; }
    const url = new URL(child);
    if (url.origin !== "https://registry.npmjs.org" && url.origin !== base) throw new Error(`Unsupported tarball origin ${url.origin}`);
    if (url.username || url.password || url.search || url.hash) throw new Error(`Unsupported tarball URL ${child}`);
    value[key] = `${base}${url.pathname}`;
  }
  return value;
}
