import { Buffer, transcode } from "node:buffer";
import { apiChecks } from "./checks.ts";
import assert from "node:assert/strict";

for (const check of apiChecks(Buffer, transcode)) {
  check.run();
  console.log(check.name);
}
assert.equal(Buffer.from("123").inspect(), Bun.inspect(Buffer.from("123")));
console.log("inspect uses the maintained Buffer formatter");
