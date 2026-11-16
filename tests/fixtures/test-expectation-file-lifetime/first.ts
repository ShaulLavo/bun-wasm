import { expect, test } from "bun:test";
import { shared, sharedPromise, sharedRejection, sharedThrower } from "./shared";
test("origin file", async () => {
  shared().toMatchInlineSnapshot(`1`);
  sharedThrower().toThrow("x");
  await sharedPromise().resolves.toBe(1);
  await sharedRejection().rejects.toBe(1);
});
