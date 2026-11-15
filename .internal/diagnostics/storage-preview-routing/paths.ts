import assert from "node:assert/strict";
import { resolve, join } from "node:path";
export const repo = resolve(import.meta.dir, "../../..");
function required(name: string) {
  const value = process.env[name];
  assert(value, `explicit owned ${name} required`);
  return value;
}
export const root = required("SR_ROOT");
export const evidence = required("SR_EVIDENCE");
export const source = { head: "2f44db5644a75283c7b2157d3b2e4d3d54d486c0", tree: "6acc944e5b534b48417d0c143b17dc3ef0d89e64" };
export const original = join(root, "browser-guest-site");
export const staged = join(root, "staged-site");
export const packet = join(root, "browser-program");
