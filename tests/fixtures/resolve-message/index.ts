import assert from "node:assert/strict";

try {
  Bun.resolveSync("./café-missing-🎉", "/tmp/café-très-🎉/file.ts");
  assert.fail("missing module resolved");
} catch (error) {
  assert.equal(error.name, "ResolveMessage");
  assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
  assert.equal(error.specifier, "./café-missing-🎉");
  assert.equal(error.referrer, "/tmp/café-très-🎉/file.ts");
  assert.equal(error.level, "error");
  error.message = "changed";
  assert.equal(error.message, "changed");
}
try {
  require("node:sqlıte");
  assert.fail("unknown builtin resolved");
} catch (error) {
  assert.equal(error.code, "ERR_UNKNOWN_BUILTIN_MODULE");
  assert.equal(error.specifier, "node:sqlıte");
}
try {
  Bun.resolveSync("badjson", import.meta.path);
  assert.fail("malformed manifest resolved");
} catch (error) {
  assert.equal(error.notes.length, 1);
  assert.equal(error.notes[0].message, "Unexpected end of file");
  assert.ok(error.notes[0].position.file.endsWith("/badjson/package.json"));
}
console.log("structured resolver errors");
