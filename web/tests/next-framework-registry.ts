import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recorderErrorHeader } from "../../scripts/app-matrix/registry.mjs";
import { advisoryResponseLimit, registryIdentity } from "../../scripts/app-matrix/registry-identity";

const shared = "/work/cache/bun-wasm-app-matrix";
type Entry = { status: number; type: string; sha256: string };
function index(directory: string): Record<string, Entry> {
  const filename = join(directory, "index.json");
  if (!existsSync(filename)) return {};
  const data: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!data || typeof data !== "object") throw new Error("Invalid registry index");
  const entries: Record<string, Entry> = {};
  for (const [path, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object" || !("sha256" in entry) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid registry entry ${path}`);
    if (!("status" in entry) || typeof entry.status !== "number" || !("type" in entry) || typeof entry.type !== "string") throw new Error(`Invalid registry entry ${path}`);
    entries[path] = { sha256: entry.sha256, status: entry.status, type: entry.type };
  }
  return entries;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function nextRegistry(directory: string, port: number, overlay?: string) {
  const borrowed = index(shared);
  const supplemental = index(directory);
  const advisories = overlay ? index(overlay) : {};
  const requests: string[] = [];
  const misses: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "cross-origin-resource-policy": "cross-origin" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      try {
        const identity = await registryIdentity(request);
        const { key, method } = identity;
        requests.push(key);
        const entry = method === "POST" ? advisories[key] : supplemental[key] ?? borrowed[key];
        if (!entry) { misses.push(key); return new Response(`Unrecorded ${key}`, { status: 503, headers: { ...headers, [recorderErrorHeader]: "1" } }); }
        const root = method === "POST" && overlay ? overlay : supplemental[key] ? directory : shared;
        const filename = join(root, "objects", entry.sha256);
        if (method === "POST" && statSync(filename).size > advisoryResponseLimit) throw new Error("Advisory response exceeds limit");
        const bytes = readFileSync(filename);
        if (sha256(bytes) !== entry.sha256) throw new Error(`Registry digest mismatch ${key}`);
        return new Response(bytes, { status: entry.status, headers: { ...headers, "content-type": entry.type } });
      } catch (error) {
        const key = `${request.method} ${new URL(request.url).pathname}`;
        misses.push(key);
        return new Response(String(error), { status: 502, headers: { ...headers, [recorderErrorHeader]: "1" } });
      }
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, requests, misses, close: () => server.stop(true) };
}

async function prepare(directory: string, lockfile: string) {
  mkdirSync(join(directory, "objects"), { recursive: true });
  const existing = index(shared);
  const added = index(directory);
  const lock: unknown = Bun.JSONC.parse(readFileSync(lockfile, "utf8"));
  if (!lock || typeof lock !== "object" || !("packages" in lock) || !lock.packages || typeof lock.packages !== "object") throw new Error("Invalid fixture lockfile");
  for (const row of Object.values(lock.packages)) await stageRow(row, directory, existing, added);
  writeFileSync(join(directory, "index.json"), JSON.stringify(added, null, 2));
  process.stdout.write(`Supplemented ${Object.keys(added).length} locked tarballs; borrowed registry unchanged\n`);
}

async function stageRow(row: unknown, directory: string, existing: Record<string, Entry>, added: Record<string, Entry>) {
  if (!Array.isArray(row) || typeof row[0] !== "string") throw new Error("Invalid lock row");
  const specifier = row[0];
  const split = specifier.lastIndexOf("@");
  const name = specifier.slice(0, split);
  const version = specifier.slice(split + 1);
  const path = `/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
  if (existing[path] || added[path]) return;
  const response = await fetch(`https://registry.npmjs.org${path}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download ${path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (typeof row[3] !== "string" || !row[3].startsWith("sha512-")) throw new Error(`Missing integrity ${path}`);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== row[3]) throw new Error(`Integrity mismatch ${path}`);
  const digest = sha256(bytes);
  writeFileSync(join(directory, "objects", digest), bytes);
  added[path] = { status: 200, type: "application/octet-stream", sha256: digest };
}
if (import.meta.main) {
  const [directory, lockfile] = process.argv.slice(2);
  if (!directory || !lockfile) throw new Error("Usage: bun next-framework-registry.ts supplement-directory fixture-lockfile");
  await prepare(resolve(directory), resolve(lockfile));
}
