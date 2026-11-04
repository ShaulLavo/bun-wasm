// Every native-quality run writes the required roots, so a missing one fails packing.
// Optional roots exist only after the producer restored the Rust job's native Cargo cache.
export type NativeHandoffRoot = {
  readonly path: string;
  readonly presence: "required" | "optional";
  readonly purpose: string;
};

export const nativeTargetRoots = [
  { path: ".ci-input-times.json", presence: "required", purpose: "build-input timestamps from quality-input-times.ts" },
  { path: "debug", presence: "required", purpose: "host build scripts and proc macros from WASI clippy, kept for the Rust job's cache save" },
  { path: "release", presence: "required", purpose: "host clippy and release test outputs, including the TLS host BoringSSL record" },
  { path: "wasm32-wasip1/debug", presence: "required", purpose: "WASI clippy outputs, including the TLS WASI BoringSSL record" },
  { path: "tls-probe", presence: "required", purpose: "sealed TLS probe handoff the Rust job verifies and runs" },
  { path: "wasm32-wasip1/release", presence: "optional", purpose: "guest outputs restored from the Rust job's cache; a cold producer never builds them" },
] as const satisfies readonly NativeHandoffRoot[];
