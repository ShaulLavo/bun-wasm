import assert from "node:assert/strict";

const element = { element(token) { token.setInnerContent("rewritten"); } };
const document = { end(token) { token.append("!"); } };
const rewriter = new HTMLRewriter().on("div", element);
const intercepted = new Set<unknown>();
let output: string | undefined;
try {
  for (let index = 0; index < 8; index++) {
    Object.defineProperty(Array.prototype, index, {
      configurable: true,
      get() { return undefined; },
      set(value) { intercepted.add(value); },
    });
  }
  output = rewriter.on("p", element).onDocument(document).transform("<p>original</p>");
} finally {
  for (let index = 0; index < 8; index++) Reflect.deleteProperty(Array.prototype, index);
}
assert.equal(output, "<p>rewritten</p>!");
assert.equal(intercepted.size, 0);
console.log("HTML private handlers and output ignore indexed prototype accessors");
