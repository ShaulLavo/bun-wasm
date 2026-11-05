import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

type Result = { observations: [string, unknown, unknown][] };

function run(mode: string): Result {
  const fixture = new URL("./fixtures/host-entry-context.ts", import.meta.url).pathname;
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture, mode], { encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const line = result.stdout.split("\n").find(value => value.startsWith("HOST_ENTRY_RESULT "));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice("HOST_ENTRY_RESULT ".length));
}

test("host-originated entries do not inherit another request's stores on the hook path", () => {
  const reference = run("reference");
  expect(run("hooks").observations).toEqual(reference.observations);
});

test("without the root entry the hook path leaks request A's S2 store into request B", () => {
  const leaked = run("hooks-without-root").observations.filter(([site, , s2]) => /\.B\.(enter|resumed|exit)$/.test(site) && s2 === "A2");
  expect(leaked.map(([site]) => site.split(".")[0])).toEqual(["io", "io", "io", "timer", "timer", "timer", "wake", "wake", "wake", "beforeExit", "beforeExit", "beforeExit"]);
});
