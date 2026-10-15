import { callerSourceOrigin } from "bun:jsc";
import { helper, afterAwait, later } from "./helper.mjs";
import cjs from "./helper.cjs";
import { helper as special } from "./space # ü.mjs";

console.log("top", callerSourceOrigin() === import.meta.url);
console.log("helper", helper().origin === new URL("./helper.mjs", import.meta.url).href);
console.log("cjs", cjs.helper().origin === new URL("./helper.cjs", import.meta.url).href);
console.log("encoded", special().origin === new URL("./space%20%23%20%C3%BC.mjs", import.meta.url).href);
console.log("await", (await afterAwait()).origin === new URL("./helper.mjs", import.meta.url).href);
console.log("timer", (await later()).origin === new URL("./helper.mjs", import.meta.url).href);
