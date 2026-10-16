const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module.prototype.require;
let calls = 0;
Module.prototype.require = function (id) {
  if (id === "node:path") calls++;
  return original.call(this, id);
};
try {
  const name = "node:path";
  assert.equal(require(name).join("a", "b"), "a/b");
} finally { Module.prototype.require = original; }
assert.equal(calls, 1);
console.log("prototype require interception");
