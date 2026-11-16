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
