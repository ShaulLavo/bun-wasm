import { expect, test } from "bun:test";
import { DescriptorTable, OpenDescription } from "waffle/core/descriptors";
import * as client from "waffle/proc/worker-client";
import { inheritedFilesystemControl, webIdlBoundaryControl } from "./worker-bootstrap-control.js";

test("WASI copies Wasm path and stdio bytes before browser decoders", () => {
  expect(webIdlBoundaryControl()).toMatchObject({ pathDecoded: true, stdioDecoded: true });
});

test("worker bootstrap preserves real filesystem rights, shared offsets and unlink-open lifetime", async () => {
  expect(await inheritedFilesystemControl()).toEqual({
    reads: "bcdef", finalOffset: 6, sharedDescription: true, preservedRights: true,
    unlinkedOpenRead: true, released: true, startupStatus: 0,
  });
});

test.skip("partial inherited binding import is typed and rolls back all descriptors (pending Waffle #23)", () => {
  const transport = client.createWorkerProcessTransport();
  transport.bindings = [
    { fd: 17, reference: 0, rightsBase: 1n, rightsInheriting: 0n },
    { fd: 31, reference: 1, rightsBase: 1n, rightsInheriting: 0n },
  ];
  transport.resources = ["retained", "reject"];
  const descriptors = new DescriptorTable();
  const stream = { kind: "terminal" as const, read: () => 0, write: () => 0, readiness: () => ({ readable: false, writable: true, hangup: false }) };
  const events: string[] = [];
  const codecUnderTest = {
    import(token: unknown) {
      if (token === "reject") throw new TypeError("binding rejected");
      return new OpenDescription(stream, () => events.push("dispose inherited"));
    },
    export() { throw new Error("unexpected export"); }, discard() {},
  };
  expect(() => client.installWorkerBindings(transport, descriptors, codecUnderTest)).toThrow(TypeError);
  expect(descriptors.get(17)).toBeUndefined();
  expect(events).toEqual(["dispose inherited"]);
});

test.todo("generic child runtime diagnostics reach stderr completely before close: pending separate Waffle child-diagnostics fix; generic bootstrap currently drops the error text");
