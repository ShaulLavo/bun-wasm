import { expect, test } from "bun:test";
import { shared, sharedPromise, sharedRejection } from "./shared";
function rejectedSnapshot(run: () => unknown) {
  let message = "";
  try { run(); } catch (error) { if (error instanceof Error) message = error.message; }
  expect(message).toContain("Snapshot matchers cannot be used outside of a test");
  expect(message).not.toContain("Snapshot creation is disabled");
}
test("plain assertion permits cross-file reuse", () => shared().toBe(1));
test("file snapshot rejects original-file reuse", () => rejectedSnapshot(() => shared().toMatchSnapshot()));
test("inline snapshot permits cross-file reuse", () => shared().toMatchInlineSnapshot(`1`));
test("not error precedes snapshot lifetime", () => {
  expect(() => shared().not.toMatchSnapshot()).toThrow("Snapshot matchers cannot be used with not");
});
test("promise chain retains original file", async () => {
  let message = "";
  try { await sharedPromise().resolves.toMatchSnapshot(); } catch (error) { if (error instanceof Error) message = error.message; }
  expect(message).toContain("Snapshot matchers cannot be used outside of a test");
});

test("rejection chain retains original file", async () => {
  let message = "";
  try { await sharedRejection().rejects.toMatchSnapshot(); } catch (error) { if (error instanceof Error) message = error.message; }
  expect(message).toContain("Snapshot matchers cannot be used outside of a test");
});
