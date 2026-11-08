import { expect, test } from "bun:test";
import { engineStackBudgets } from "../src/engine-stack-budget";

const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15";
const geckoStack = "engineStackBudgets@http://localhost/worker.js:10:2\n@http://localhost/worker.js:20:1";

test("Firefox keeps QuickJS's standard guarded budget instead of the smaller Safari budget", () => {
  expect(engineStackBudgets(geckoStack, firefox)).toEqual({ jsc: "192" });
});

test("Safari and unmeasured hosts retain both conservative stack budgets", () => {
  expect(engineStackBudgets(geckoStack, safari)).toEqual({ quickjs: "32", jsc: "192" });
  expect(engineStackBudgets("", "")).toEqual({ quickjs: "32", jsc: "192" });
});

test("V8 keeps the guest defaults without changing browser or engine detection", () => {
  expect(engineStackBudgets("Error\n    at createBunExecutor (worker.js:10:2)", "Chrome/157.0.0.0")).toBeNull();
});
