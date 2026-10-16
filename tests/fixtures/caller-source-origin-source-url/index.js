import { callerSourceOrigin } from "bun:jsc";
import { makeEval } from "./helper.mjs";

globalThis.reviewCaller = callerSourceOrigin;
const helper = new URL("./helper.mjs", import.meta.url).href;
const file = "file:///eval-created.mjs";
const https = "https://example.invalid/eval-created.mjs";
const map = "https://example.invalid/unrelated.js.map";
const cases = [
  ["file sourceURL", "//# sourceURL=" + file, file],
  ["https sourceURL", "//# sourceURL=" + https, https],
  ["legacy sourceURL", "//@ sourceURL=" + file, file],
  ["sourceURL then sourceMappingURL", "//# sourceURL=" + file + "\n//# sourceMappingURL=" + map, file],
  ["sourceMappingURL then sourceURL", "//# sourceMappingURL=" + map + "\n//# sourceURL=" + https, https],
  ["file sourceMappingURL", "//# sourceMappingURL=file:///unrelated.js.map", helper],
  ["https sourceMappingURL", "//# sourceMappingURL=" + map, helper],
  ["legacy sourceMappingURL", "//@ sourceMappingURL=" + map, helper],
  ["inline sourceMappingURL", "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IiJ9", helper],
];
let failed = false;
for (const [name, directives, expected] of cases) {
  const { origin } = makeEval(directives)();
  const ok = origin === expected || origin === null;
  console.log(name, ok);
  if (!ok) { console.error(name, "wrong origin", origin); failed = true; }
}
if (failed) throw new Error("tagged eval origin regression");
