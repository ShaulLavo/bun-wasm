import type { FilesystemClient } from "waffle/fs/client";

export class BunWasmExecutableConflictError extends Error {
  readonly code = "BUN_WASM_EXECUTABLE_CONFLICT";
  constructor(readonly path: string) {
    super(`Cannot install Bun: a different filesystem entry already exists at ${path}`);
    this.name = "BunWasmExecutableConflictError";
  }
}

export const executableMarker = new TextEncoder().encode("bun-wasm registered executable\n");
export const matchesMarker = (bytes: Uint8Array | undefined): boolean => bytes !== undefined
  && bytes.length === executableMarker.length && bytes.every((byte, index) => byte === executableMarker[index]);

export async function createExecutable(filesystem: FilesystemClient, name: string): Promise<boolean> {
  try {
    await filesystem.asyncCall("writeFile", [name, false, true], executableMarker);
    return true;
  } catch (error) {
    if (!error || typeof error !== "object" || !("errno" in error) || error.errno !== 20) throw error;
    const entry = await filesystem.asyncCall("lookup", [name]);
    if (entry?.kind !== "file" || !matchesMarker(await filesystem.asyncCall("readFile", [name]))) {
      throw new BunWasmExecutableConflictError(name);
    }
    return false;
  }
}

export async function rollbackExecutables(filesystem: FilesystemClient, created: string[]): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(created).reverse().map((name) =>
      filesystem.asyncCall("remove", [name, true], new Uint8Array(executableMarker)),
    ),
  );
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length > 0) {
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Executable marker rollback failed");
  }
}
