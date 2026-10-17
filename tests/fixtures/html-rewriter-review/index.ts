import { strict as assert } from "node:assert";
let failures = 0;
async function check(name: string, test: () => unknown) {
  try { await test(); console.log("PASS", name); }
  catch (error) { failures++; console.log("FAIL", name, String(error)); }
}
await check("void end tag", () => {
  for (const tag of ["img", "br", "input", "meta", "hr", "wbr"]) {
    assert.throws(() => new HTMLRewriter().on("*", { element(e) { e.onEndTag(() => {}); } }).transform(`<${tag}>`), { name: "HTMLRewriterError", message: "No end tag." });
  }
  assert.equal(new HTMLRewriter().on("div", { element(e) { e.onEndTag(e => e.before("ok")); } }).transform("<div></div>"), "<div>ok</div>");
});
await check("error response", async () => {
  let ended = false;
  const input = Response.error();
  const output = new HTMLRewriter().onDocument({ end() { ended = true; } }).transform(input);
  assert.equal(output.status, 0);
  assert.equal(output.type, "error");
  assert.equal(output.ok, false);
  assert.equal(await output.text(), "");
  assert.equal(ended, true);
});
await check("nullish selectors", () => {
  for (const selector of [null, undefined]) assert.throws(() => new HTMLRewriter().on(selector, {}), { name: "TypeError", message: "Expected string" });
  assert.equal(new HTMLRewriter().on("null", { element(e) { e.setInnerContent("ok"); } }).transform("<null></null>"), "<null>ok</null>");
});
assert.equal(failures, 0);
