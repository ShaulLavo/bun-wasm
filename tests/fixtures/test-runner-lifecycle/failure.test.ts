import { afterAll, onTestFinished, test } from "bun:test";

let attempts = 0;
test("exhausted retry", () => {
  attempts++;
  onTestFinished(() => console.log(`retry finished ${attempts}`));
  throw new Error("expected retry failure");
}, { retry: 2 });

test("repeat stops", () => {
  console.log("repeat attempted once");
  onTestFinished(() => console.log("failed repeat finished"));
  throw new Error("expected repeat failure");
}, { repeats: 2 });

test("cleanup stops on failure", () => {
  afterAll(() => console.log("must not run after cleanup failure"));
  afterAll(() => { console.log("cleanup failed"); throw new Error("expected cleanup failure"); });
  onTestFinished(() => console.log("must not finish after cleanup failure"));
});
