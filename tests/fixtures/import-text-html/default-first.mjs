import ordinary from "./page.html";
import page from "./page.html" with { type: "text" };
import assert from "node:assert/strict";
assert.equal(typeof page, "string");
assert.equal(Object.prototype.toString.call(ordinary), "[object HTMLBundle]");
console.log("order passes");
export { ordinary, page };
