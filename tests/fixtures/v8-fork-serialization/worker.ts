import assert from "node:assert/strict";
import { serialize, deserialize } from "node:v8";

process.once("message", message => {
  const value = deserialize(Buffer.from(message));
  assert.equal(value.m, "fetchModule");
  assert.equal(value.cycle, value);
  assert.equal(Buffer.isBuffer(value.buffer), true);
  process.send!(serialize(value), () => process.disconnect());
});
