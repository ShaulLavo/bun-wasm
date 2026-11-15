import type { FilesystemClient } from "waffle/fs/client";
import { FilesystemError } from "waffle/fs/protocol";

export class BunWasmExecutableConflictError extends Error {
  readonly code = "BUN_WASM_EXECUTABLE_CONFLICT";
  constructor(readonly path: string) {
    super(`Cannot install Bun: a different filesystem entry already exists at ${path}`);
    this.name = "BunWasmExecutableConflictError";
  }
}

const executableMarker = new TextEncoder().encode("bun-wasm registered executable\n");
export const matchesMarker = (bytes: Uint8Array | undefined): boolean => bytes !== undefined
  && bytes.length === executableMarker.length && bytes.every((byte, index) => byte === executableMarker[index]);

export async function createExecutable(filesystem: FilesystemClient, name: string): Promise<boolean> {
  try {
    await filesystem.asyncCall("writeFile", [name, false, true], executableMarker);
    return true;
  } catch (error) {
    if (!(error instanceof FilesystemError) || error.errno !== 20) throw error;
    const entry = await filesystem.asyncCall("lookup", [name]);
    if (entry?.kind !== "file" || !matchesMarker(await filesystem.asyncCall("readFile", [name]))) {
      throw new BunWasmExecutableConflictError(name);
    }
    return false;
  }
}

export async function rollbackExecutables(filesystem: FilesystemClient, created: string[]): Promise<void> {
  for (const name of created.reverse()) {
    try {
      if (!matchesMarker(await filesystem.asyncCall("readFile", [name]))) continue;
      await filesystem.asyncCall("remove", [name]);
    } catch {
      // A failed operation owns its own result; continue without touching page errors.
    }
  }
}

