import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function sharedCache() {
  mkdirSync("alias", { recursive: true });
  writeFileSync("first.mjs", 'export const value = "first";');
  writeFileSync("second.mjs", 'export const value = "second";');
  const original = 'module.exports = { value: 1, load: () => import("./first.mjs") };';
  const rewritten = 'module.exports = { value: 2, load: () => import("./first.mjs") };';
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  writeFileSync("chunk.cjs", original);
  const path = require.resolve("./chunk.cjs");
  const first = require(path);
  assert.equal(first, require("./alias/../chunk.cjs"));
  assert.equal((await first.load()).value, "first");
  writeFileSync("chunk.cjs", rewritten);
  assert.equal(require(path), first);
  assert.equal(first.value, 1);
  delete require.cache[path];
  const second = require(path);
  assert.notEqual(second, first);
  assert.equal(second.value, 2);
  assert.equal(require(path), second);
  console.log("source cache: evaluated CommonJS identity and same-length reload pass");

  writeFileSync("chunk.cjs", '/* longer UTF-8 prefix: café 🥞 */ module.exports = { value: 3, load: () => import("./second.mjs") };');
  assert.equal(require(path), second);
  delete require.cache[path];
  const third = require(path);
  assert.equal(third.value, 3);
  assert.equal((await third.load()).value, "second");
  writeFileSync("other.cjs", 'module.exports = { value: 3 };');
  assert.notEqual(require("./other.cjs"), third);
  console.log("source cache: changed dynamic-import spans and separate paths pass");

  writeFileSync("data.json", '{"value":1}');
  const dataPath = require.resolve("./data.json");
  const data = require(dataPath);
  writeFileSync("data.json", '{"value":2}');
  assert.equal(require(dataPath), data);
  delete require.cache[dataPath];
  assert.equal(require(dataPath).value, 2);
  console.log("source cache: JSON identity and reload pass");

  writeFileSync("stable.mjs", 'export const value = 1;');
  const stable = await import("./stable.mjs");
  writeFileSync("stable.mjs", 'export const value = 2;');
  assert.equal(await import("./stable.mjs"), stable);
  assert.equal(stable.value, 1);
  console.log("source cache: ESM import identity stays cached");
}

async function convertedCache() {
  writeFileSync("first.mjs", 'export const value = "first";');
  writeFileSync("second.mjs", 'export const value = "second";');
  writeFileSync("converted.mjs", 'export const value = 1; export const load = () => import("./first.mjs");');
  const convertedPath = require.resolve("./converted.mjs");
  const converted = require(convertedPath);
  assert.equal(converted.value, 1);
  assert.equal((await converted.load()).value, "first");
  writeFileSync("converted.mjs", '/* changed prefix */ export const value = 2; export const load = () => import("./second.mjs");');
  assert.equal(require(convertedPath), converted);
  assert.equal(converted.value, 1);
  delete require.cache[convertedPath];
  const refreshed = require(convertedPath);
  assert.notEqual(refreshed, converted);
  assert.equal(refreshed.value, 2);
  assert.equal((await refreshed.load()).value, "second");
  assert.equal(require(convertedPath), refreshed);
  console.log("source cache: ESM-to-CommonJS bytes and imports refresh after deletion");
}

if (process.argv.includes("--browser-cache")) {
  await sharedCache();
  await convertedCache();
} else if (process.argv.includes("--host-engine")) {
  await convertedCache();
} else {
  await sharedCache();
}
