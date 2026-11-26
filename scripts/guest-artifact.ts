import { mapProgramFiles, pairedEngineKinds, parseProgramFiles, programKind, programProfile, verifyProgramSide, type ProgramFiles } from "../src/engine-kind.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

export const GUEST_ORIGIN = "https://bun-artifacts.shaulavo.dev";
export const GUEST_BUCKET = "bun-wasm-guests";
export const GUEST_CACHE_CONTROL = "public, max-age=31536000, immutable, no-transform";

export interface GuestFileDescriptor {
  readonly url: string;
  /** Both integrity fields cover decompressed WASM, never its gzip representation. */
  readonly sha256: string;
  readonly bytes: number;
}

export type GuestDescriptor = ProgramFiles<GuestFileDescriptor>;

export interface GuestFile {
  readonly descriptor: GuestFileDescriptor;
  readonly key: string;
  readonly gzip: Uint8Array;
}

export interface GuestArtifact {
  readonly descriptor: GuestDescriptor;
  readonly files: ProgramFiles<GuestFile>;
}

export function decodeGuest(input: Uint8Array): Uint8Array {
  const bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const magic = [0, 97, 115, 109, 1, 0, 0, 0];
  if (!magic.every((byte, index) => bytes[index] === byte) || !WebAssembly.validate(bytes)) {
    throw new Error("Expected a valid WASM version 1 module (raw or gzip)");
  }
  return bytes;
}

export function validateArtifactName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*\.wasm$/.test(name) || name.includes("..")) {
    throw new Error(`Invalid WASM artifact name: ${name}`);
  }
  return name;
}

export function describeGuest(input: Uint8Array, origin = GUEST_ORIGIN, name = "bun.wasm"): GuestFileDescriptor {
  const validName = validateArtifactName(name);
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Guest origin must be a plain HTTPS origin");
  }
  const bytes = decodeGuest(input);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { url: `${base.origin}/${sha256}/${validName}.gz`, sha256, bytes: bytes.byteLength };
}

export function prepareArtifact(input: Uint8Array, origin = GUEST_ORIGIN, name = "bun.wasm"): GuestFile {
  const validName = validateArtifactName(name);
  const bytes = decodeGuest(input);
  const descriptor = describeGuest(bytes, origin, validName);
  return { descriptor, key: `${descriptor.sha256}/${validName}.gz`, gzip: gzipSync(bytes, { level: 9 }) };
}

export function prepareGuest(input: ProgramFiles<Uint8Array>, origin = GUEST_ORIGIN): GuestArtifact {
  const coreBytes = decodeGuest(input.core);
  if (programKind(new WebAssembly.Module(Uint8Array.from(coreBytes))) !== input.kind) throw new Error("Guest program does not match core engine declaration");
  const core = prepareArtifact(coreBytes, origin, input.kind === "single" ? "bun.wasm" : programProfile(input.kind).core);
  if (input.kind === "single") return { files: { kind: "single", core }, descriptor: { kind: "single", core: core.descriptor } };
  const sideBytes = decodeGuest(input.side);
  verifyProgramSide(input.kind, new WebAssembly.Module(Uint8Array.from(sideBytes)));
  const side = prepareArtifact(sideBytes, origin, programProfile(input.kind).side);
  const files = { kind: input.kind, core, side };
  return { files, descriptor: mapProgramFiles(files, file => file.descriptor) };
}

export function parseGuestFileDescriptor(value: unknown): GuestFileDescriptor {
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string"
    || !("sha256" in value) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !("bytes" in value) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 8) {
    throw new TypeError("Invalid guest file descriptor");
  }
  return { url: value.url, sha256: value.sha256, bytes: value.bytes };
}

export function parseGuestDescriptor(value: unknown): GuestDescriptor {
  return parseProgramFiles(value, parseGuestFileDescriptor);
}

const BUN_GUEST_IMPORT_MODULES = new Set(["bun_package_scripts"]);
const BUN_GUEST_EXPORTS = new Set(
  ["bun_wasm_host_slots", "bun_core_bind_engine", "bunwasm_ready", "bunwasm_alloc", "bunwasm_call", "bunwasm_describe"]
    .concat(pairedEngineKinds.flatMap(kind => {
      const profile = programProfile(kind);
      const names: string[] = [profile.run];
      return names.concat(profile.initialize, profile.initializeMemory);
    })),
);

export function assertStandaloneArtifactModule(module: WebAssembly.Module): void {
  if (programKind(module) !== "single") {
    throw new Error("Standalone artifact must be a single-module WASM file, not a Bun paired core");
  }
  if (WebAssembly.Module.imports(module).some(entry => BUN_GUEST_IMPORT_MODULES.has(entry.module))) {
    throw new Error("Bun guest modules must use the default Bun guest publication path without --name");
  }
  if (WebAssembly.Module.exports(module).some(entry => BUN_GUEST_EXPORTS.has(entry.name))) {
    throw new Error("Bun guest or engine modules must use the default Bun guest publication path without --name");
  }
}

export async function readArtifactFile(path: string, origin = GUEST_ORIGIN, name = "bun.wasm"): Promise<GuestFile> {
  const bytes = decodeGuest(await readFile(path));
  assertStandaloneArtifactModule(new WebAssembly.Module(Uint8Array.from(bytes)));
  return prepareArtifact(bytes, origin, name);
}

export async function readGuestArtifact(path: string, origin = GUEST_ORIGIN): Promise<GuestArtifact> {
  const core = decodeGuest(await readFile(path));
  const kind = programKind(new WebAssembly.Module(Uint8Array.from(core)));
  if (kind === "single") return prepareGuest({ kind, core }, origin);
  const sidePath = join(dirname(path), programProfile(kind).side);
  const side = await readFile(sidePath);
  return prepareGuest({ kind, core, side }, origin);
}

export function verifyGuest(input: Uint8Array, expected: GuestFileDescriptor): void {
  const actual = describeGuest(input);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`Guest integrity mismatch: expected ${expected.sha256} (${expected.bytes} bytes), received ${actual.sha256} (${actual.bytes} bytes)`);
  }
}

export async function writeGuestDescriptor(output: string, descriptor: GuestDescriptor): Promise<void> {
  const path = resolve(output);
  const assets = fileURLToPath(new URL("../src/assets.js", import.meta.url));
  const typePath = relative(dirname(path), assets).replaceAll("\\", "/");
  const specifier = typePath.startsWith(".") ? typePath : `./${typePath}`;
  const source = `// Generated by guest artifact tooling; verify publication before release.\n`
    + `// SHA-256 and bytes cover decompressed WASM. Do not edit by hand.\n`
    + `import type { BunWasmAsset } from ${JSON.stringify(specifier)};\n\n`
    + `export const BUN_WASM_ASSET: BunWasmAsset | null = ${JSON.stringify(descriptor, null, 2)};\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { origin: { type: "string", default: GUEST_ORIGIN }, output: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("Usage: bun scripts/guest-artifact.ts <bun.wasm[.gz]> [--origin https://host] [--output descriptor.ts]");
  const inputPath = resolve(positionals[0]!);
  const { descriptor } = await readGuestArtifact(inputPath, values.origin);
  if (values.output) await writeGuestDescriptor(values.output, descriptor);
  console.log(JSON.stringify(descriptor, null, 2));
}
