import { test } from "bun:test";
import { apiChecks } from "../tests/fixtures/buffer-api-contract/checks.ts";
import { checkResizableConcat } from "../tests/fixtures/buffer-concat-resizable/check.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer, transcode } = loadBufferSource();
for (const check of apiChecks(SourceBuffer, transcode)) test(check.name, check.run);

test("concat sizes captured views after all getters shrink their backing", () => {
  checkResizableConcat(SourceBuffer);
});
