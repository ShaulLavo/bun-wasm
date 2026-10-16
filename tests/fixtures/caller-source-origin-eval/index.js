import { callerSourceOrigin } from "bun:jsc";
import { makeEval, directEval, makeFunction, hasEvalMetadata } from "./helper.mjs";

globalThis.reviewCaller = callerSourceOrigin;
globalThis.reviewEvalMetadata = hasEvalMetadata;
const helper = new URL("./helper.mjs", import.meta.url).href;
const cases = [
  ["cross-module eval", makeEval(), helper],
  ["direct eval", directEval, helper],
  ["Function caller", makeFunction(), helper],
];
let failed = false;
for (const [name, fn, actualOrigin] of cases) {
  const result = fn();
  const ok = result.origin === actualOrigin || (result.origin === null && !result.metadata);
  console.log(name, ok);
  if (!ok) { console.error(name, "wrong origin", JSON.stringify(result)); failed = true; }
}
if (failed) throw new Error("opaque caller origin regression");
