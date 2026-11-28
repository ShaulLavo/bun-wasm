import { test } from "bun:test";

test("root test must not run", () => {
  throw new Error("wrong root test executed");
});
