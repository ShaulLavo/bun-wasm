import { expect, test } from "bun:test";
import { options } from "./run";
import { queuedNativeCommand } from "./mac-queue";

test("native admission requires explicit lane and actual T3 thread identity", () => {
  expect(() => queuedNativeCommand(options(["--asset-source=test"]), ["bun", "run.js"], "task")).toThrow("lane");
});
