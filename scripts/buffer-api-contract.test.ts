import { test } from "bun:test";
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
  if (result.toString("hex") !== "c3a4") throw new Error("Foreign byte array was not transcoded");
  for (const source of [new Uint8ClampedArray([65]), { [Symbol.toStringTag]: "Uint8Array", length: 1, 0: 65 }]) {
    try { transcode(source, "ascii", "utf8"); } catch (error) {
      if (error instanceof TypeError && Reflect.get(error, "code") === "ERR_INVALID_ARG_TYPE") continue;
      throw error;
    }
    throw new Error("Non-byte-array source was accepted");
  }
});
