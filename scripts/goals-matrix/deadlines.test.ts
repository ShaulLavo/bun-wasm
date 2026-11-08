import { expect, test } from "bun:test";
import { options } from "./run";

test("an explicit Nuxt install budget leaves the campaign phase timeout unchanged", () => {
  const config = options(["--asset-source=test", "--timeout-ms=90000", "--install-timeout-ms=nuxt:110000"]);
  expect(config).toMatchObject({ timeoutMs: 90_000, installTimeouts: { nuxt: 110_000 } });
});
