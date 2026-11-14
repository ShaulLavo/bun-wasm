import { test } from "bun:test";
import { encodingChecks } from "../tests/fixtures/buffer-encoding-bindings/contract.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: RuntimeBuffer } = loadBufferSource();
for (const check of encodingChecks(RuntimeBuffer)) test(check.name, check.run);
