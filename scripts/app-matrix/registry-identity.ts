import { createHash } from "node:crypto";

export const advisoryPath = "/-/npm/v1/security/advisories/bulk";
export const advisoryBodyLimit = 64 * 1024;
export const advisoryResponseLimit = 4 * 1024 * 1024;
const registryDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function boundedRegistryBody(message: Request | Response, limit: number): Promise<Buffer<ArrayBuffer>> {
  if (Number(message.headers.get("content-length")) > limit) {
    await message.body?.cancel();
    throw new Error("Registry body exceeds limit");
  }
  const reader = message.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Registry body exceeds limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}

type RegistryIdentity = { key: string; path: string; method: "GET"; body: undefined } | { key: string; path: string; method: "POST"; body: Buffer<ArrayBuffer> };

export async function registryIdentity(request: Request): Promise<RegistryIdentity> {
  const url = new URL(request.url);
  if (url.search || url.hash || url.pathname.startsWith("//")) throw new Error("Unsupported registry URL");
  const path = url.pathname;
  if (request.method === "GET" && path !== advisoryPath && !request.body) return { key: path, path, method: "GET", body: undefined };
  if (request.method !== "POST" || path !== advisoryPath) throw new Error("Unsupported registry method/path");
  if (request.headers.has("content-encoding")) throw new Error("Encoded advisory requests are unsupported");
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new Error("Advisory request requires JSON");
  const body = await boundedRegistryBody(request, advisoryBodyLimit);
  const packages: unknown = JSON.parse(body.toString("utf8"));
  if (!packages || typeof packages !== "object" || Array.isArray(packages) || !Object.keys(packages).length) throw new Error("Invalid advisory packages");
  for (const versions of Object.values(packages)) {
    if (!Array.isArray(versions) || !versions.length || !versions.every(version => typeof version === "string")) throw new Error("Invalid advisory versions");
  }
  return { key: `POST ${path} ${registryDigest(body)}`, path, method: "POST", body };
}
