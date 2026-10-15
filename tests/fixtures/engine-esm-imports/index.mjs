// ES module semantics through JSC's module loader: several builtin imports read in one
// expression (each import has its own import slot), top-level await, dynamic import, import.meta.
import { readFileSync, existsSync } from "fs";
import path from "node:path";
import { format } from "util";
import { counter, bump } from "./lib/counter.mjs";

console.log(typeof readFileSync, typeof existsSync, path.basename("/a/b.txt"), format("%s=%d", "n", 3));
console.log("live before", counter);
bump();
console.log("live after", counter);
const value = await new Promise((resolve) => setTimeout(() => resolve("awaited"), 5));
console.log("top-level await:", value);
const dyn = await import("node:path");
console.log("dynamic builtin:", dyn.default.join("x", "y"), typeof dyn.join);
console.log("meta:", import.meta.url, import.meta.path, import.meta.dir, import.meta.file, import.meta.main);
