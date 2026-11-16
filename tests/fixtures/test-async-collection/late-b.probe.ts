import assert from "node:assert/strict";
import { afterAll, onTestFinished, test } from "bun:test";
import { gate, completed, rejected, events } from "./late-state.ts";

test("later execution", async () => {
  gate.resolve(); await completed.promise;
  assert.deepEqual(rejected, ["test", "describe", "afterAll", "finished"]);
  afterAll(() => events.push("local"));
  onTestFinished(() => events.push("finished"));
});
test("ordinary execution cleanup", () => {
  assert.deepEqual(events, ["local", "finished"]);
  console.log("event:closed file guards and ordinary cleanup");
});
