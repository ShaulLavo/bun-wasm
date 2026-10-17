import { strict as assert } from "node:assert";

const rewriter = new HTMLRewriter().on('div[data-x="a"]', {
  element(element) {
    assert.equal(element.tagName, "div");
    assert.equal(element.namespaceURI, "http://www.w3.org/1999/xhtml");
    assert.deepEqual(Array.from(element.attributes), [["data-x", "a"]]);
    element.tagName = "section";
    element.setAttribute("data-x", "b").prepend("<b>", { html: false }).append("!", { html: true });
    element.onEndTag(end => { end.before("<i>end</i>", { html: true }); });
  },
  text(text) { if (text.text) text.replace(text.text.toUpperCase()); },
  comments(comment) { comment.text = "changed"; },
}).onDocument({
  doctype(doctype) { assert.equal(doctype.name, "html"); doctype.remove(); assert.equal(doctype.removed, true); },
  end(end) { end.append("done"); },
});
const input = '<!doctype html><div data-x="a">hello<!--x--></div>';
const expected = '<section data-x="b">&lt;b&gt;HELLO<!--changed-->!<i>end</i></section>done';
assert.equal(rewriter.transform(input), expected);
assert.equal(new TextDecoder().decode(rewriter.transform(new TextEncoder().encode(input).buffer)), expected);
assert.equal(new TextDecoder().decode(rewriter.transform(new DataView(new TextEncoder().encode(input).buffer))), expected);
assert.throws(() => rewriter.on("div[", {}));
assert.throws(() => rewriter.on("div", null));
assert.throws(() => new HTMLRewriter().on("p", { element() { throw 42; } }).transform("<p>x</p>"), e => e === 42);
console.log("sync tokens, selectors, and binary inputs pass");

const order: string[] = [];
let stale;
const asyncRewriter = new HTMLRewriter().on("p", {
  async element(element) {
    const id = element.getAttribute("id");
    order.push(`start:${id}`);
    await new Promise(resolve => setTimeout(resolve, 1));
    element.setInnerContent("<b>async</b>", { html: true });
    element.onEndTag(async end => { await Promise.resolve(); end.after("!"); });
    order.push(`end:${id}`);
  },
  text(text) { stale = text; },
});
const response = new Response('<p id="1">a</p><p id="2">b</p>', { status: 201, headers: { "x-test": "yes", "content-length": "100" } });
const result = asyncRewriter.transform(response);
assert.equal(result.status, 201);
assert.equal(result.headers.get("x-test"), "yes");
assert.equal(result.headers.get("content-length"), "100");
assert.equal(await result.text(), '<p id="1"><b>async</b></p>!<p id="2"><b>async</b></p>!');
assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
assert.equal(response.bodyUsed, true);
assert.equal(stale.removed, undefined);
assert.throws(() => asyncRewriter.transform(response));
console.log("async handlers, order, and response metadata pass");

for (const value of [undefined, null, false, 0, "failure", { error: true }]) {
  const output = new HTMLRewriter().on("p", { async element() { await Promise.resolve(); throw value; } }).transform(new Response("<p>x</p>"));
  const observed = await output.text().then(() => ({ resolved: true }), error => ({ error }));
  assert.equal(observed.error, value);
}
console.log("handler rejection identity passes");

let inputController;
let cancelled = 0;
const source = new ReadableStream({ start(c) { inputController = c; }, cancel() { cancelled++; } });
const transformed = new HTMLRewriter().on("p", { element(e) { e.setAttribute("streamed", "yes"); } }).transform(new Response(source));
const reader = transformed.body.getReader();
inputController.enqueue(new TextEncoder().encode("<p>first</p>"));
const first = await reader.read();
assert.equal(new TextDecoder().decode(first.value).startsWith('<p streamed="yes">'), true);
await reader.cancel("stop");
assert.equal(cancelled, 1);
console.log("incremental output and cancellation pass");
const events: string[] = [];
const allHandlers = new HTMLRewriter().onDocument({
  async doctype(token) { await Promise.resolve(); token.remove(); events.push("doctype"); },
  async comments(token) { await Promise.resolve(); token.replace("comment"); events.push("comment"); },
  async text(token) { await Promise.resolve(); if (token.text) token.replace(token.text.toUpperCase()); },
  async end(token) { await Promise.resolve(); token.append("end"); events.push("end"); },
});
assert.equal(await allHandlers.transform(new Response("<!doctype html><!--x--><p>text</p>")).text(), "comment<p>TEXT</p>end");
assert.deepEqual(events, ["doctype", "comment", "end"]);
let iterator;
const detached = new HTMLRewriter().on("p", {
  element(token) {
    iterator = token.attributes;
    token.setAttribute("added", "yes");
    assert.equal(iterator.next().done, true);
    iterator = token.attributes;
  },
});
detached.transform('<p a="b"></p>');
assert.equal(iterator.next().done, true);
let reads = 0;
const thenable = new HTMLRewriter().on("p", {
  element(token) {
    return { get then() { reads++; return resolve => { token.setInnerContent("thenable"); resolve(); }; } };
  },
});
assert.equal(await thenable.transform(new Response("<p>x</p>")).text(), "<p>thenable</p>");
assert.equal(reads, 1);
console.log("async document handlers and token lifetimes pass");
