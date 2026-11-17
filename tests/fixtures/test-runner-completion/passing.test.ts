import { afterEach, beforeEach, expect, test } from "bun:test";

let phase = 0;
beforeEach(() => { phase = 0; });
afterEach(() => { if (phase) expect(phase).toBe(2); });

test("synchronous done", done => { done(null); });
test("second done result is ignored", done => { done(); done(new Error("ignored second done")); });
test("done before a pending returned promise", async done => {
  phase = 1;
  done();
  await Bun.sleep(5);
  phase = 2;
});
test("a pending returned promise before done", async done => {
  phase = 1;
  setTimeout(() => { phase = 2; done(); }, 5);
  await Bun.sleep(1);
});
test("ordinary returned promise", async () => { await Promise.resolve(); });
