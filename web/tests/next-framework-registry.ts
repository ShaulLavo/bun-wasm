import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recorderErrorHeader } from "../../scripts/app-matrix/registry.mjs";
import { advisoryResponseLimit, registryIdentity } from "../../scripts/app-matrix/registry-identity";

const shared = "/work/cache/bun-wasm-app-matrix";
export type RegistryEntry = { status: number; type: string; sha256: string };
export type VerifiedRegistryInventory = { entries: number; bytes: number; objects: (RegistryEntry & { key: string; bytes: number })[] };
export function readRegistryIndex(directory: string, expectedSha256?: string): Record<string, RegistryEntry> {
  const filename = join(directory, "index.json");
  if (!existsSync(filename) && !expectedSha256) return {};
  const text = readFileSync(filename, "utf8");
  if (expectedSha256 && sha256(Buffer.from(text)) !== expectedSha256) throw new Error(`Original replay index mismatch ${directory}`);
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid registry index");
  const entries: Record<string, RegistryEntry> = {};
  for (const [path, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object" || !("sha256" in entry) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid registry entry ${path}`);
    if (!("status" in entry) || typeof entry.status !== "number" || !("type" in entry) || typeof entry.type !== "string") throw new Error(`Invalid registry entry ${path}`);
    const parsed = { sha256: entry.sha256, status: entry.status, type: entry.type };
    validateEntry(parsed, path);
    entries[path] = parsed;
  }
  return entries;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function verifyRegistryInventory(directory: string, entries: Readonly<Record<string, RegistryEntry>>, label: string): VerifiedRegistryInventory {
  const staged = readRegistryIndex(directory);
  if (Object.keys(staged).length !== Object.keys(entries).length) throw new Error(`Original replay inventory mismatch ${label}`);
  let bytes = 0;
  const objects: VerifiedRegistryInventory["objects"] = [];
  for (const [key, entry] of Object.entries(entries)) {
    validateEntry(entry, `${label}:${key}`);
    const current = staged[key];
    if (!current || current.sha256 !== entry.sha256 || current.status !== entry.status || current.type !== entry.type) throw new Error(`Original replay entry mismatch ${label}:${key}`);
    const filename = join(directory, "objects", entry.sha256);
    if (!existsSync(filename)) throw new Error(`Missing replay object ${label}:${key} ${entry.sha256}`);
    const object = readFileSync(filename);
    if (sha256(object) !== entry.sha256) throw new Error(`Replay digest mismatch ${label}:${key}`);
    bytes += object.byteLength;
    objects.push({ key, ...entry, bytes: object.byteLength });
  }
  return { entries: objects.length, bytes, objects };
}

function validateEntry(entry: RegistryEntry, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid replay digest ${label}`);
  if (!Number.isSafeInteger(entry.status) || entry.status < 200 || entry.status > 599) throw new Error(`Invalid replay status ${label}`);
  if (!/^[^\s/;]+\/[^\s;]+(?:;[^\r\n]*)?$/.test(entry.type)) throw new Error(`Invalid replay content type ${label}`);
}

function missingRegistryResponse(key: string, misses: string[], headers: Readonly<Record<string, string>>): Response {
  misses.push(key);
  return new Response(`Unrecorded ${key}`, { status: 503, headers: { ...headers, [recorderErrorHeader]: "1" } });
}

export function nextRegistry(directory: string, port: number, overlay?: string, originalIndexes?: readonly string[]) {
  if (originalIndexes && originalIndexes.length !== (overlay ? 3 : 2)) throw new Error("Original replay index selection mismatch");
  const borrowed = readRegistryIndex(shared, originalIndexes?.[0]);
  const supplemental = readRegistryIndex(directory, originalIndexes?.[1]);
  const advisories = overlay ? readRegistryIndex(overlay, originalIndexes?.[2]) : {};
  verifyRegistryInventory(shared, borrowed, "shared");
  verifyRegistryInventory(directory, supplemental, "supplemental");
  if (overlay) verifyRegistryInventory(overlay, advisories, "overlay");
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
        if (!entry) return missingRegistryResponse(key, misses, headers);
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
  const existing = readRegistryIndex(shared);
  const added = readRegistryIndex(directory);
  const lock: unknown = Bun.JSONC.parse(readFileSync(lockfile, "utf8"));
  if (!lock || typeof lock !== "object" || !("packages" in lock) || !lock.packages || typeof lock.packages !== "object") throw new Error("Invalid fixture lockfile");
  for (const row of Object.values(lock.packages)) await stageRow(row, directory, existing, added);
  writeFileSync(join(directory, "index.json"), JSON.stringify(added, null, 2));
  process.stdout.write(`Supplemented ${Object.keys(added).length} locked tarballs; borrowed registry unchanged\n`);
}

async function stageRow(row: unknown, directory: string, existing: Record<string, RegistryEntry>, added: Record<string, RegistryEntry>) {
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
