// An ES module (TypeScript) that declares its own `require` with
// createRequire next to other top-level consts. Bun's printer may merge
// them into one `const a = …, require = …` declaration.
import { createRequire } from "node:module";
const root: string = import.meta.dir;
const require = createRequire(import.meta.url);
const { answer } = require("./data.json");
const lib = require("./lib.cjs");
console.log("root is a string:", typeof root === "string");
console.log("require is a function:", typeof require === "function");
console.log("json:", answer, "cjs:", lib.greet("esm"));
