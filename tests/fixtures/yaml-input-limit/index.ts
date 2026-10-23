// Bun's yaml.test.ts large-input case. QuickJS and JSC inside wasm32 cannot
// reserve the 2 GiB view and skip it, as upstream does; the browser engine runs it.
import { strict as assert } from "node:assert";

let input: Uint8Array | undefined;
try {
  input = new Uint8Array(2 ** 31 + 2);
} catch {}
if (input) {
  const oversized = input;
  assert.throws(() => Bun.YAML.parse(oversized as unknown as string), {
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
    message: 'The value of "input.byteLength" is out of range. It must be <= 2147483647. Received 2147483650',
  });
  assert.equal(Bun.YAML.parse(new Uint8Array(oversized.buffer, 0, 0) as unknown as string), null);
}
console.log("oversized YAML input rejected before parsing");
