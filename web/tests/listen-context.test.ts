import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

type Observation = [site: string, store: unknown];
type Result = { results: Record<string, Observation[]>; caller?: Observation[] };

function run(mode: string): Result {
  const fixture = new URL("./fixtures/listen-context.ts", import.meta.url).pathname;
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture, mode], { encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const line = result.stdout.split("\n").find(value => value.startsWith("LISTEN_CONTEXT_RESULT "));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice("LISTEN_CONTEXT_RESULT ".length));
}

const reference = run("reference").results;

test("node:http callbacks keep the listen-time frame on the hook path, as under Node", () => {
  const hooks = run("hooks");
  expect(hooks.results).toEqual(reference);
  expect(hooks.caller).toEqual([["listening", "listen-frame"], ["caller", "caller"]]);
});

test("node:http callbacks keep the listen-time frame with a native continuation provider", () => {
  expect(run("native").results).toEqual(reference);
});
