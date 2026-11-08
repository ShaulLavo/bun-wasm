import { expect, test } from "bun:test";

test("the Next playground overlaps complete server tracing with the remaining build work", async () => {
  const { default: config } = await import(new URL("../sandbox/template-next/next.config.ts", import.meta.url).href);
  expect(config).toEqual({ experimental: { cpus: 1, parallelServerBuildTraces: true } });
});
