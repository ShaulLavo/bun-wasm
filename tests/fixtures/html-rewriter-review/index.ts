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
await check("fulfilled promise then accessor", async () => {
  let reads = 0;
  const value = { get then() {
    reads++;
    if (reads === 1) return undefined;
    throw new Error("read twice");
  } };
  const settled = Promise.resolve(value);
  const output = new HTMLRewriter().on("p", { element() { return settled; } }).transform(new Response("<p>x</p>"));
  assert.equal(await output.text(), "<p>x</p>");
  assert.equal(reads, 1);
});
await check("void end-tag registration releases callback", async () => {
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({ start(controller) { sourceController = controller; } });
  let weak: WeakRef<() => void> | undefined;
  const output = new HTMLRewriter().on("img", { element(element) {
    const callback = () => {};
    weak = new WeakRef(callback);
    try { element.onEndTag(callback); } catch (error) { assert.equal((error as Error).message, "No end tag."); }
  } }).transform(new Response(source));
  const reader = output.body!.getReader();
  sourceController!.enqueue(new TextEncoder().encode("<img>"));
  await reader.read();
  const collect = typeof Bun !== "undefined" ? () => Bun.gc(true) : () => globalThis.gc?.();
  for (let i = 0; i < 4 && weak!.deref() !== undefined; i++) { await new Promise(resolve => setTimeout(resolve, 0)); collect(); }
  assert.equal(weak!.deref(), undefined);
  await reader.cancel("done");
});
await check("response header snapshot", async () => {
  const input = new Response("<p>x</p>", { headers: { "x-test": "before" } });
  const output = new HTMLRewriter().on("p", { element() { input.headers.set("x-test", "after"); } }).transform(input);
  assert.equal(output.headers.get("x-test"), "before");
  assert.equal(input.headers.get("x-test"), "after");
  assert.equal(await output.text(), "<p>x</p>");
});
assert.equal(failures, 0);
