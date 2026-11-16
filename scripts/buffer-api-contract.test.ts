import { test } from "bun:test";
import assert from "node:assert/strict";
import { apiChecks } from "../tests/fixtures/buffer-api-contract/checks.ts";
import { checkResizableConcat } from "../tests/fixtures/buffer-concat-resizable/check.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer, transcode } = loadBufferSource();
for (const check of apiChecks(SourceBuffer, transcode)) test(check.name, check.run);

test("concat sizes captured views after all getters shrink their backing", () => {
  checkResizableConcat(SourceBuffer);
});

test("transcode accepts a byte array from another realm and rejects tag spoofs", () => {
  const result = transcode(new Uint8Array([0xe4]), "latin1", "utf8");
  assert.equal(result.toString("hex"), "c3a4");
  for (const source of [new Uint8ClampedArray([65]), { [Symbol.toStringTag]: "Uint8Array", length: 1, 0: 65 }]) {
    assert.throws(() => transcode(source, "ascii", "utf8"), { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  }
});

test("transcode checks the live source after encoding coercion and before name validation", () => {
  for (const mode of ["detach", "shrink", "out-of-bounds"]) {
    const backing = new ArrayBuffer(4, { maxByteLength: 8 });
    const source = SourceBuffer.from(backing, 2, 2);
    const events: string[] = [];
    const from = { toString() {
      events.push("from");
      if (mode === "detach") backing.transfer();
      else backing.resize(mode === "shrink" ? 0 : 2);
      return "bad";
    } };
    const to = { toString() { events.push("to"); return "bad"; } };
    assert.equal(Reflect.apply(transcode, undefined, [source, from, to]).length, 0);
    assert.deepEqual(events, ["from", "to"]);
  }
});
