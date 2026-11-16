import { expect, test } from "bun:test";
import { shared, sharedPromise, sharedRejection } from "./shared";
test("origin file", async () => {
  shared().toMatchInlineSnapshot(`1`);
  await sharedPromise().resolves.toBe(1);
  await sharedRejection().rejects.toBe(1);
});
