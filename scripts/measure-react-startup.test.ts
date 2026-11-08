import { expect, test } from "bun:test";
import { checkStartupLimit, median, sampleDeadline, type StartupSample } from "./measure-react-startup";

function sample(cache: StartupSample["cache"], renderMs: number): StartupSample {
  return { revision: "control", url: "http://localhost/", iteration: 0, cache, renderMs, interactiveMs: renderMs + 1, phases: [], requests: [], dependencies: {}, cacheMarks: [] };
}

test("startup medians keep all samples and do not mutate their input", () => {
  const durations = [300, 100, 200];
  expect(median(durations)).toBe(200);
  expect(durations).toEqual([300, 100, 200]);
  expect(median([100, 200])).toBe(150);
  expect(() => median([])).toThrow("missing samples");
});

test("startup gate requires both cold and warm renders", () => {
  expect(() => checkStartupLimit([sample("cold", 100)], 110)).toThrow("missing samples");
  expect(() => checkStartupLimit([sample("cold", 100), sample("warm", 90)], 110)).not.toThrow();
});

test("startup gate rejects a 20 times slowdown without widening its deadline", () => {
  expect(() => checkStartupLimit([sample("cold", 2000), sample("warm", 90)], 110)).toThrow("cold React render");
  expect(() => checkStartupLimit([sample("cold", 100), sample("warm", 2000)], 110)).toThrow("warm React render");
});

test("startup gate rejects invalid budgets", () => {
  const samples = [sample("cold", 100), sample("warm", 90)];
  for (const limit of [NaN, Infinity, 0, -1]) expect(() => checkStartupLimit(samples, limit)).toThrow("positive and finite");
});

test("a sample has one deadline across all render and interaction steps", async () => {
  await expect(sampleDeadline(new Promise<never>(() => {}), 10)).rejects.toThrow("sample exceeded 10 ms");
  await expect(sampleDeadline(Promise.resolve("rendered"), 100)).resolves.toBe("rendered");
});
