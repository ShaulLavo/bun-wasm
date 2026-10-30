import { deepStrictEqual, strictEqual } from "node:assert";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

export async function verifyReadlineIteration(): Promise<void> {
  const input = new PassThrough();
  const rl = createInterface({ input });
  const iterator = rl[Symbol.asyncIterator]();
  try {
    const first = iterator.next();
    input.write("first\n");
    deepStrictEqual(await first, { done: false, value: "first" });
    strictEqual(input.readableEnded, false);
    const second = iterator.next();
    input.end("second\nlast");
    deepStrictEqual(await second, { done: false, value: "second" });
    deepStrictEqual(await iterator.next(), { done: false, value: "last" });
    strictEqual((await iterator.next()).done, true);
    strictEqual(input.listenerCount("data"), 0);
    strictEqual(input.listenerCount("end"), 0);
  } finally {
    rl.close();
    await iterator.return?.();
    input.destroy();
  }
}
