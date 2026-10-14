import def, { named, counter, bump } from "./lib/math.mjs";
import * as ns from "./lib/math.mjs";
import { fromIndex } from "./lib/dir";
import { noExt } from "./lib/noext";
import data from "./data/config.json";
import { name as dataName } from "./data/config.json";

console.log("default:", def(2, 3));
console.log("named:", named);
console.log("live binding before:", counter);
bump();
console.log("live binding after:", counter);
console.log("namespace keys:", Object.keys(ns).sort().join(","));
console.log("index resolution:", fromIndex);
console.log("extension resolution:", noExt);
console.log("json default:", data.name, data.list.length);
console.log("json named:", dataName);

console.log("meta.url:", import.meta.url);
console.log("meta.dir:", import.meta.dir);
console.log("meta.path:", import.meta.path);
console.log("meta.file:", import.meta.file);
console.log("meta.main:", import.meta.main);
console.log("meta.resolve:", import.meta.resolve("./lib/math.mjs"));

const value = await new Promise((resolve) => setTimeout(() => resolve("tla done"), 5));
console.log("top-level await:", value);

const dyn = await import("./lib/dynamic.mjs");
console.log("dynamic import:", dyn.default, dyn.loadedFrom);
const again = await import("./lib/dynamic.mjs");
console.log("same instance:", dyn === again);

try {
  await import("./does-not-exist.mjs");
} catch (err) {
  console.log("missing import rejects:", err instanceof Error);
}
