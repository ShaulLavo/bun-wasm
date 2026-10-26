import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { serialize, deserialize } from "node:v8";

const child = fork(new URL("./worker.ts", import.meta.url).pathname, process.argv.slice(2), { silent: true });
const exit = new Promise<number | null>((resolve, reject) => {
  child.once("exit", resolve);
  child.once("error", reject);
});
const reply = new Promise<unknown>((resolve, reject) => {
  child.once("message", resolve);
  child.once("exit", code => reject(new Error(`Child exited before sending a reply (code ${code})`)));
  child.once("error", reject);
});
try {
  const input = { m: "fetchModule", a: ["/app.ts"], i: "rpc-1", t: "q", cycle: null as unknown,
    buffer: Buffer.from([4, 8]), big: 10000000000000001n, missing: undefined, nan: NaN, zero: -0 };
  input.cycle = input;
  child.send(serialize(input));
  const output = deserialize(Buffer.from(await reply));
  assert.equal(output.m, "fetchModule");
  assert.deepEqual(output.a, ["/app.ts"]);
  assert.equal(output.cycle, output);
  assert.equal(output.big, input.big);
  assert.equal(Object.hasOwn(output, "missing"), true);
  assert.equal(output.missing, undefined);
  assert.equal(Number.isNaN(output.nan), true);
  assert.equal(Object.is(output.zero, -0), true);
  assert.equal(Buffer.isBuffer(output.buffer), true);
  assert.deepEqual(Array.from(output.buffer), [4, 8]);
  assert.equal(await exit, 0);
  console.log("v8 bytes preserve cyclic RPC values through fork IPC");
} finally {
  if (child.exitCode === null) child.kill();
}
