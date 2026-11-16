import { beforeAll, describe, test } from "bun:test";

for (const register of [() => test("outside", () => {}), () => describe("outside", () => {}), () => beforeAll(() => {})]) {
  try { register(); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
}
