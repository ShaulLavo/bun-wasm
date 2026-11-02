export type NativeHandoffConsumer = "rust";

export type NativeTargetRoot = {
  readonly consumer: NativeHandoffConsumer;
  readonly path: string;
  readonly purpose: string;
};

export const nativeTargetRoots = [
  { consumer: "rust", path: ".ci-input-times.json", purpose: "preserve build-input timestamps" },
  { consumer: "rust", path: "debug", purpose: "reuse host build-script and proc-macro outputs" },
  { consumer: "rust", path: "release", purpose: "reuse native Cargo quality outputs" },
  { consumer: "rust", path: "wasm32-wasip1/debug", purpose: "reuse WASI quality outputs" },
  { consumer: "rust", path: "wasm32-wasip1/release", purpose: "reuse WASI guest outputs" },
] as const satisfies readonly NativeTargetRoot[];

export function isNativeTargetPathAllowed(path: string): boolean {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return false;
  return nativeTargetRoots.some(root => path === root.path || path.startsWith(`${root.path}/`));
}
