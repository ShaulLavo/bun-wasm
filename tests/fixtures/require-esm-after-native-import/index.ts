import { createRequire } from "node:module";

globalThis.order = [];
globalThis.sharedRuns = 0;
const require = createRequire(import.meta.url);
const pending = import("./p.mts");
require("./r.mts");
await pending;
console.log("order", (globalThis.order as string[]).join(","));
console.log("d runs", globalThis.sharedRuns);
console.log("same", await import("./d.mts") === require("./d.mts"));
