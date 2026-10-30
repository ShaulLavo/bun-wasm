const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(process.cwd(), "hermes-nft-require-"));
const nftDirectory = path.join(directory, "node_modules/next/dist/compiled/@vercel/nft");
const nft = path.join(nftDirectory, "index.js");
const other = path.join(nftDirectory, "other.js");
const target = path.join(nftDirectory, "target.cts");
const source = 'var runtimeRequire=true?eval("require"):0;module.exports={lexical:require,gyp:runtimeRequire,bindings(){var requireFunc=true?eval("require"):0;return requireFunc}};';
const missing = { name: "ReferenceError", message: "Property 'require' doesn't exist" };
const originalCwd = process.cwd();
try {
  assert.equal(Object.hasOwn(globalThis, "require"), false);
  // oxlint-disable-next-line no-eval -- Observe global scope rather than the CommonJS parameter.
  assert.equal((0, eval)("typeof require"), "undefined");
  fs.mkdirSync(nftDirectory, { recursive: true });
  fs.writeFileSync(path.join(directory, "target.cts"), 'module.exports = "wrong cwd";');
  fs.writeFileSync(target, 'module.exports = "module-relative";');
  fs.writeFileSync(nft, source);
  fs.writeFileSync(other, source);
  process.chdir(directory);
  const loaded = require(nft);
  assert.equal(loaded.gyp, loaded.lexical);
  assert.equal(loaded.bindings(), loaded.lexical);
  assert.equal(loaded.gyp("./target.cts"), "module-relative");
  assert.equal(loaded.bindings().resolve("./target.cts"), target);
  assert.throws(() => require(other), missing);
  delete require.cache[nft];
  fs.writeFileSync(nft, source + 'eval("require");');
  assert.throws(() => require(nft), missing);
  assert.equal(Object.hasOwn(globalThis, "require"), false);
  // oxlint-disable-next-line no-eval -- Observe global scope rather than the CommonJS parameter.
  assert.equal((0, eval)("typeof require"), "undefined");
  console.log("nft module-relative require ok");
} finally {
  process.chdir(originalCwd);
  for (const file of [nft, other, target]) delete require.cache[file];
  fs.rmSync(directory, { recursive: true, force: true });
}
