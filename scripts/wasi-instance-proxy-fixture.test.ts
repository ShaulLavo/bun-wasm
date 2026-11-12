import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { proxyFixture, upstream } from "./wasi-instance-proxy-fixture";

test("the exact generated wasi-threads proxy fixture stays pinned", () => {
  const source = readFileSync(new URL("../tests/fixtures/shared-wasm-memory/instance-proxy.js", import.meta.url));
  expect(createHash("sha256").update(source).digest("hex")).toBe(upstream.fixtureSha256);
  expect(() => proxyFixture("changed input")).toThrow("Changed pinned wasi-threads source");
  expect(readFileSync(new URL("../tests/fixtures/shared-wasm-memory/wasi-threads-LICENSE.txt", import.meta.url), "utf8")).toContain("Permission is hereby granted");
});
