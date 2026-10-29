import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function registryReceipt(paths: readonly string[]) {
  const indexes = paths.map(path => {
    const text = readFileSync(path, "utf8");
    const entries: unknown = JSON.parse(text);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`Invalid registry index ${path}`);
    return { path: resolve(path), text, keys: Object.keys(entries), sha256: digest(text) };
  });
  return {
    entries: new Set(indexes.flatMap(index => index.keys)).size,
    sha256: digest(indexes.map(index => index.text).join("\n")),
    inputs: indexes.map(index => ({ path: index.path, sha256: index.sha256, entries: index.keys.length })),
  };
}
