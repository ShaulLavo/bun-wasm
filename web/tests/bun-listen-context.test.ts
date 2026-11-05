import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

type Sites = Record<string, string | null>;
type Output = {
  results: Record<string, Sites>;
  caller?: [string, unknown][];
  retirement?: Record<string, { active?: boolean; stopped: boolean; reachable: boolean }>;
};

function run(command: string, args: string[], prefix: string): Output {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const line = result.stdout.split("\n").find(value => value.startsWith(`${prefix} `));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice(prefix.length + 1));
}

const adapterFixture = new URL("./fixtures/bun-listen-context.ts", import.meta.url).pathname;
const adapter = (mode: string) => run("node", ["--expose-gc", "--disable-warning=ExperimentalWarning", adapterFixture, mode], "BUN_LISTEN_CONTEXT");
// Native Bun over loopback sockets; this test already runs on it.
const referenceFixture = new URL("./fixtures/bun-listen-reference.ts", import.meta.url).pathname;
const reference = run(process.execPath, [referenceFixture], "BUN_LISTEN_REFERENCE").results;

// The hook-path fixture runs node_net on Node's own streams, whose close emission is deferred
// on Node's ticks rather than the guest's, so the close callbacks there are compared only with
// a native continuation provider, which follows Node's ticks.
function withoutClose(results: Record<string, Sites>): Record<string, Sites> {
  return Object.fromEntries(Object.entries(results).map(([kind, sites]) =>
    [kind, Object.fromEntries(Object.entries(sites).filter(([site]) => !site.endsWith(" close")))]));
}

test("Bun.listen and Bun.connect callbacks keep their registration frames with a native continuation provider, as under Bun", () => {
  expect(adapter("native").results).toEqual(reference);
});

test("Bun.listen and Bun.connect callbacks keep their registration frames on the hook path, as under Bun", () => {
  const hooks = adapter("hooks");
  expect(withoutClose(hooks.results)).toEqual(withoutClose(reference));
  // A synchronous pump in the caller's own `run` accepts in the listen-time frame, then
  // hands the caller's frame back.
  expect(hooks.caller).toEqual([["open", "listen-frame"], ["caller", "caller"]]);
  // An accepted socket holds the listen-time frame while it is open; once the listener stopped
  // and its sockets closed, the still reachable listener holds it no longer.
  expect(hooks.retirement).toEqual({
    "stop without sockets": { stopped: false, reachable: true },
    "force stop with a live socket": { active: true, stopped: false, reachable: true },
    "stop, then the live socket closes": { active: true, stopped: false, reachable: true },
  });
});
