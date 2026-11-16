import { test } from "bun:test";
import { apiChecks } from "../tests/fixtures/buffer-api-contract/checks.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer, transcode } = loadBufferSource();
for (const check of apiChecks(SourceBuffer, transcode)) test(check.name, check.run);
