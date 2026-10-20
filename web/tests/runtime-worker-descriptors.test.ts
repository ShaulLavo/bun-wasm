import { expect, test } from "bun:test";
import { inheritedFilesystemControl, partialBindingRollbackControl, webIdlBoundaryControl } from "./worker-bootstrap-control.js";

test("WASI copies Wasm path and stdio bytes before browser decoders", () => {
  expect(webIdlBoundaryControl()).toMatchObject({ pathDecoded: true, stdioDecoded: true });
});

test("worker bootstrap preserves real filesystem rights, shared offsets and unlink-open lifetime", async () => {
  expect(await inheritedFilesystemControl()).toEqual({
    reads: "bcdef", finalOffset: 6, sharedDescription: true, preservedRights: true,
    unlinkedOpenRead: true, released: true, startupStatus: 0,
  });
});

test("partial inherited binding import is typed and rolls back all descriptors", () => {
  expect(partialBindingRollbackControl()).toEqual({ typed: true, rolledBack: true, released: true });
});
