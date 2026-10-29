import { createFilesystemIdentity } from "waffle/fs";
import { processRuntimeFixture } from "./process-runtime-fixture";

export function networkPathScopeFixture(_context: unknown, directory: number) {
  return { filesystem: createFilesystemIdentity(), directory };
}

export async function socketDirectoryFixture() {
  return { handle: 1, release() {} };
}

export function socketRuntimeFixture(...[overrides, options]: Parameters<typeof processRuntimeFixture>) {
  return processRuntimeFixture({ directoryHandle: socketDirectoryFixture, ...overrides }, options);
}
