// The Wasm `name` custom section holds debug names for functions and locals. It is useful to
// profilers and symbolizers and useless to users, who download it: about 2.2 MB raw, 8% of the
// gzipped guest. Every shipped guest, core and engine side drops it; each producer keeps a named
// copy (`*.named.wasm`) for tools. CLI: `strip IN OUT` and `check FILE...`.
import { readFileSync, writeFileSync } from "node:fs";

/** Guests, cores and engine sides that ship to users and must stay free of debug names. */
export const nameFreeGuests: readonly string[] = ["bun-browser.wasm", "bun.wasm", "quickjs.wasm", "bun-jsc.wasm", "jsc-engine.wasm", "bun-tools.wasm"];

interface Section { readonly id: number; readonly start: number; readonly end: number; readonly name: string | undefined }

function readUnsigned(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = bytes[at++];
    if (byte === undefined) throw new TypeError("Truncated Wasm integer");
    if (shift === 28 && byte > 0x0f) throw new TypeError("Invalid Wasm integer");
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, next: at };
  }
  throw new TypeError("Invalid Wasm integer");
}

function sections(bytes: Uint8Array): Section[] {
  const magic = [0, 97, 115, 109, 1, 0, 0, 0];
  if (!magic.every((byte, index) => bytes[index] === byte)) throw new TypeError("Expected a Wasm version 1 module");
  const found: Section[] = [];
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++]!;
    const size = readUnsigned(bytes, at);
    const end = size.next + size.value;
    if (end > bytes.length) throw new TypeError("Truncated Wasm section");
    let name: string | undefined;
    if (id === 0) {
      const length = readUnsigned(bytes, size.next);
      if (length.next + length.value > end) throw new TypeError("Truncated Wasm custom section name");
      name = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes.subarray(length.next, length.next + length.value));
    }
    found.push({ id, start, end, name });
    at = end;
  }
  return found;
}

export function hasNameSection(bytes: Uint8Array): boolean {
  return sections(bytes).some(section => section.name === "name");
}

/** Remove every `name` custom section. All other bytes stay as they were. */
export function stripNameSection(bytes: Uint8Array): Uint8Array {
  const kept = sections(bytes).filter(section => section.name !== "name");
  const chunks = [bytes.subarray(0, 8)].concat(kept.map(section => bytes.subarray(section.start, section.end)));
  return Buffer.concat(chunks);
}

/** Fail for a shipped guest that carries debug names. */
export function assertNoNameSection(bytes: Uint8Array, label: string): void {
  if (hasNameSection(bytes)) throw new Error(`${label} carries a Wasm name section; ship the stripped build (scripts/wasm-name-sections.ts strip)`);
}

/**
 * Apply the check to the guests that must stay name free; other guests are left alone.
 * A local profiling site may opt in to names with `keepNames` (the site builds read
 * BUN_WASM_KEEP_NAMES=1); CI and publication never do.
 */
export function assertShippedGuestHasNoNames(name: string, bytes: Uint8Array, keepNames = false): void {
  if (!keepNames && nameFreeGuests.includes(name)) assertNoNameSection(bytes, name);
}

export const keepNamesRequested = (): boolean => process.env.BUN_WASM_KEEP_NAMES === "1";

/** Fail unless `stripped` is name free and is exactly `named` without its name section. */
export function assertNamedCopyMatches(named: Uint8Array, stripped: Uint8Array, label: string): void {
  assertNoNameSection(stripped, label);
  if (Buffer.compare(stripNameSection(named), stripped) !== 0) throw new Error(`${label} is not its named copy without names; rebuild it in a fresh build directory`);
}

function readNamedCopy(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`Missing named copy ${path}; rebuild in a fresh build directory`);
    throw error;
  }
}

if (import.meta.main) {
  const [command, ...paths] = process.argv.slice(2);
  if (command === "strip" && paths.length === 2) {
    const stripped = stripNameSection(readFileSync(paths[0]!));
    writeFileSync(paths[1]!, stripped);
    console.log(`${paths[1]}: ${stripped.byteLength} bytes, no name section`);
  } else if (command === "check" && paths.length > 0) {
    for (const path of paths) assertNoNameSection(readFileSync(path), path);
  } else if (command === "matches" && paths.length === 2) {
    assertNamedCopyMatches(readNamedCopy(paths[0]!), readFileSync(paths[1]!), paths[1]!);
  } else {
    throw new Error("Usage: wasm-name-sections.ts strip IN OUT | check FILE... | matches NAMED STRIPPED");
  }
}
