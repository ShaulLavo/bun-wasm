import inputs from "./inputs.lock.json" with { type: "json" };

export const policy = { initialMemory: 1024, maximumMemory: 4096 };
export const variantVersion = "0.94.0-bun-wasm-memory.1";
export const addons = inputs.addons;
export type Addon = (typeof addons)[number];

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected strings");
  return Array.from(value, item => {
    if (typeof item !== "string") throw new Error("Expected strings");
    return item;
  });
}

export function configuredManifest(original: unknown, maintained: boolean) {
  const manifest = object(original);
  const napi = object(manifest.napi);
  const wasm = object(napi.wasm);
  return {
    ...manifest,
    version: maintained ? variantVersion : manifest.version,
    napi: { ...napi, wasm: { ...wasm, ...(maintained ? policy : {}) } },
  };
}

export function packageManifest(original: unknown, maintained: boolean) {
  const manifest = object(original);
  if (!maintained) return manifest;
  return { ...manifest, version: variantVersion, files: strings(manifest.files).concat(["bun-wasm-variant.json"]) };
}
