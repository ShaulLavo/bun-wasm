import { test } from "bun:test";

// A rejection left unhandled in the load turn fails the file: Bun runs none of its tests.
setImmediate(() => {
  Promise.reject(new Error("rejected in the load turn"));
});

test("b never runs", () => {
  console.log("b: test");
});
