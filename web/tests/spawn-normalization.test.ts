import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/spawn.js", import.meta.url), "utf8");

for (const executable of ["node", "/usr/bin/node", "fixture.wasm", "/tools/custom"]) {
  test(`guest command normalization preserves registry executable ${executable}`, () => {
    let metadata: { executable: string; argv: string[] } | undefined;
    const factory = runInNewContext(source, {
      process: { execPath: "/bun", argv0: "bun", env: {} }, URL,
    });
    const api = factory({
      require,
      native: {
        cwd: () => "/",
        hostCaps: { spawn: true },
        hostSpawn(text: string) { metadata = JSON.parse(text); return -1; },
        hostError: () => '{"message":"deliberate test stop","code":"EIO"}',
      },
    });
    expect(() => api.spawn([executable, "argument"])).toThrow("deliberate test stop");
    expect(metadata).toEqual({
      executable, argv: [executable, "argument"], cwd: "/", env: {},
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
  });
}

for (const ownCode of [23, 143]) test(`a handled TERM preserves guest own code ${ownCode} in the Bun facade`, async () => {
  let status = -2;
  let waiter: { step(): unknown } | undefined;
  const factory = runInNewContext(source, {
    process: { execPath: "/usr/local/bin/bun", argv0: "bun", env: {} }, URL,
  });
  const api = factory({
    require,
    addIoWaiter(value: { step(): unknown }) { waiter = value; return value; },
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2,
      hostChildWait: () => status, hostChildKill: () => 0, hostClose: () => 0,
    },
  });
  const child = api.spawn(["fixture"], { stdio: ["ignore", "ignore", "ignore"] });
  child.kill("SIGTERM");
  status = ownCode;
  waiter!.step();
  expect(await child.exited).toBe(ownCode);
  expect(child.exitCode).toBe(ownCode);
  expect(child.signalCode).toBeNull();
  expect(child.killed).toBe(true);
});

for (const signal of ["SIGTERM", "SIGKILL"]) test(`spawnSync timeout ${signal} preserves request versus forced status`, () => {
  let status = -2;
  let now = 0;
  const requested: number[] = [];
  const factory = runInNewContext(source, { process: { env: {} }, URL });
  const api = factory({
    require, concatBytes: () => new Uint8Array(),
    native: {
      cwd: () => "/", hostCaps: { spawn: true }, hostSpawn: () => 2,
      now: () => now++, hostChildWait: () => status, hostPoll() {}, hostClose: () => 0,
      hostChildKill(_pid: number, number: number) { requested.push(number); status = number === 9 ? 137 : 23; return 0; },
    },
  });
  const result = api.spawnSync(["fixture"], { stdio: ["ignore", "ignore", "ignore"], timeout: 1, killSignal: signal });
  expect(result.exitedDueToTimeout).toBe(true);
  expect(result.exitCode).toBe(signal === "SIGKILL" ? null : 23);
  expect(result.signalCode).toBe(signal === "SIGKILL" ? "SIGKILL" : null);
  expect(requested).toEqual([signal === "SIGKILL" ? 9 : 15]);
});
