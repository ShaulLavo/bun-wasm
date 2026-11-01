import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootPin = {
  repository: "https://github.com/oven-sh/bun",
  commit: "9510e74152073d850a18758ca41114d8f214ffa6",
  path: "packages/bun-usockets/root_certs.der",
  sha256: "9c211f519356eff61365ff890856135b1b8ee298775b144ce6089782ae603f90",
  count: 121,
  bytes: 129635,
};

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseRootBundle(input: Uint8Array): readonly Uint8Array[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.byteLength < 8) throw new Error("Truncated TLS root bundle header");
  const count = view.getUint32(0, true);
  if (count !== rootPin.count) throw new Error("Unexpected TLS root count");
  const header = 4 + 4 * (count + 1);
  if (header > input.byteLength) throw new Error("Truncated TLS root offsets");
  const size = input.byteLength - header;
  if (view.getUint32(4, true) !== 0 || view.getUint32(4 * (count + 1), true) !== size) {
    throw new Error("TLS root offsets do not consume the whole payload");
  }
  return Array.from({ length: count }, (_, index) => {
    const start = view.getUint32(4 * (index + 1), true);
    const end = view.getUint32(4 * (index + 2), true);
    if (start >= end || end > size) throw new Error("TLS root offsets must increase within the payload");
    const der = input.subarray(header + start, header + end);
    checkCertificate(der);
    return der;
  });
}

function checkCertificate(der: Uint8Array) {
  if (der[0] !== 0x30) throw new Error("TLS root is not a DER sequence");
  const end = checkDer(der, 0, der.length, 0);
  if (end !== der.length) throw new Error("TLS root contains trailing DER data");
  const certificate = new X509Certificate(der);
  if (!certificate.raw.equals(der)) throw new Error("TLS root decoder did not consume the complete DER certificate");
  if (!certificate.ca) throw new Error("TLS trust anchor is not a CA certificate");
}

function checkDer(bytes: Uint8Array, offset: number, limit: number, depth: number): number {
  if (depth > 32 || offset + 2 > limit) throw new Error("Invalid DER nesting or truncated tag");
  const tag = bytes[offset]!;
  if ((tag & 31) === 31 || tag === 0) throw new Error("Unsupported DER tag");
  const [start, length] = derLength(bytes, offset + 1, limit);
  const end = start + length;
  if (end > limit) throw new Error("DER value extends past its parent");
  if ((tag & 32) === 0) return end;
  let cursor = start;
  while (cursor < end) cursor = checkDer(bytes, cursor, end, depth + 1);
  if (cursor !== end) throw new Error("DER children do not consume their parent");
  return end;
}

function derLength(bytes: Uint8Array, offset: number, limit: number): readonly [number, number] {
  const first = bytes[offset]!;
  if (first < 128) return [offset + 1, first];
  const octets = first & 127;
  if (octets === 0 || octets > 4 || offset + 1 + octets > limit || bytes[offset + 1] === 0) {
    throw new Error("Invalid DER length encoding");
  }
  let length = 0;
  for (let index = 1; index <= octets; index++) length = length * 256 + bytes[offset + index]!;
  if (length < 128) throw new Error("Non-minimal DER length encoding");
  return [offset + 1 + octets, length];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid TLS root provenance");
  return Object.fromEntries(Object.entries(value));
}

export function verifyRootBundle(input: Uint8Array, source: unknown) {
  const roots = parseRootBundle(input);
  const provenance = record(source);
  for (const [key, value] of Object.entries(rootPin)) {
    if (provenance[key] !== value) throw new Error(`TLS root provenance has an incorrect ${key}`);
  }
  if (input.byteLength !== rootPin.bytes || sha256(input) !== rootPin.sha256) throw new Error("TLS root bundle does not match the reviewed pin");
  if (provenance.schema !== 1 || provenance.nssRelease !== null || provenance.importedAt !== "2026-11-01") {
    throw new Error("TLS root provenance schema, import date or NSS claim changed");
  }
  if (provenance.origin !== "Mozilla NSS certdata.txt, filtered for SERVER_AUTH:TRUSTED_DELEGATOR") throw new Error("Invalid TLS root origin");
  const license = record(provenance.license);
  if (license.identifier !== "MPL-2.0" || license.upstreamNoticePath !== "packages/bun-usockets/certdata.txt"
    || license.notice !== "This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.") {
    throw new Error("TLS root license notice changed");
  }
  const sourceFiles = sourceFileRecords(provenance.sourceFiles);
  return { count: roots.length, bytes: input.byteLength, sha256: sha256(input), sourceFiles };
}

function sourceFileRecords(value: unknown) {
  if (!Array.isArray(value) || value.length !== 5) throw new Error("Missing TLS root source records");
  const names = ["packages/bun-usockets/certdata.txt", "packages/bun-usockets/root_certs.txt", "packages/bun-usockets/generate-root-certs.pl", "packages/bun-usockets/generate-root-certs.mjs", "src/runtime/socket/bundled_root_certs.rs"];
  return value.map((item, index) => {
    const source = record(item);
    if (typeof source.path !== "string" || source.path !== names[index] || typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256)) {
      throw new Error("Invalid TLS root source record");
    }
    return { path: source.path, sha256: source.sha256 };
  });
}

export function verifyRootSource(odb: string, input: Uint8Array, source: unknown) {
  const result = verifyRootBundle(input, source);
  const upstream = (path: string) => execFileSync("git", ["-C", odb, "show", `${rootPin.commit}:${path}`], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  if (!upstream(rootPin.path).equals(input)) throw new Error("TLS root bytes differ from the exact upstream Git object");
  for (const file of result.sourceFiles) {
    if (sha256(upstream(file.path)) !== file.sha256) throw new Error(`TLS root source digest mismatch for ${file.path}`);
  }
  return result;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const input = readFileSync(resolve(root, "crates/bunwasm-runtime/data/tls-roots.der"));
  const source: unknown = JSON.parse(readFileSync(resolve(root, "crates/bunwasm-runtime/data/tls-roots.source.json"), "utf8"));
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--upstream")) throw new Error("Usage: bun scripts/tls-roots.ts [--upstream EXISTING_BUN_ODB]");
  const result = args[1] ? verifyRootSource(args[1], input, source) : verifyRootBundle(input, source);
  console.log(JSON.stringify(result, null, 2));
}
