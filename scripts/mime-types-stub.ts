// native.mimeTypeInterned for harnesses that run the runtime's JavaScript with stub natives.
// It reads the same list as crates/bunwasm-runtime/src/mime_types.rs and gives the same values.
import { readFileSync } from "node:fs";

const names = new Set(readFileSync(new URL("../crates/bunwasm-runtime/data/bun-mime-types.txt", import.meta.url), "utf8").split("\n").filter(Boolean));
const canonical = new Map([
  ["application/webassembly", "application/wasm"],
  ["application/javascript", "text/javascript;charset=utf-8"],
  ["text/javascript", "text/javascript;charset=utf-8"],
  ["text/jsx", "text/javascript;charset=utf-8"],
  ["application/json", "application/json;charset=utf-8"],
  ["application/x-www-form-urlencoded", "application/x-www-form-urlencoded;charset=UTF-8"],
  ["text/css", "text/css;charset=utf-8"],
  ["text/html", "text/html;charset=utf-8"],
  ["text/plain", "text/plain;charset=utf-8"],
]);

export function mimeTypeInterned(name: string): string | undefined {
  if (!names.has(name)) return undefined;
  return canonical.get(name) ?? name;
}
