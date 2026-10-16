const fs = require("node:fs");
const assert = require("node:assert/strict");
fs.mkdirSync("closed-tree");
async function main() {
  const directory = fs.opendirSync("closed-tree");
  directory.closeSync();
  let called = false;
  assert.throws(() => directory.read(() => { called = true; }), { code: "ERR_DIR_CLOSED" });
  assert.throws(() => directory.read(undefined), { code: "ERR_DIR_CLOSED" });
  await assert.rejects(directory.read(), { code: "ERR_DIR_CLOSED" });
  await assert.rejects(directory.close(), { code: "ERR_DIR_CLOSED" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
  console.log("closed callback and explicit undefined reads throw; no-argument calls reject");
}
main();
