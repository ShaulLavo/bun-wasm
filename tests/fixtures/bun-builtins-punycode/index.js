import assert from "node:assert/strict";
import punycode from "node:punycode";

Bun.gc(true);
assert.equal(punycode, require("punycode"));
assert.equal(punycode.encode("Bücher"), "Bcher-kva");
assert.equal(punycode.decode("Bcher-kva"), "Bücher");
assert.equal(punycode.toASCII("mañana.com"), "xn--maana-pta.com");
assert.equal(punycode.toUnicode("xn--maana-pta.com"), "mañana.com");
assert.deepEqual(punycode.ucs2.decode("𩸽"), [0x29e3d]);
assert.equal(punycode.ucs2.encode([0x29e3d]), "𩸽");
assert.throws(() => punycode.decode("α-"), RangeError);
console.log("Bun punycode passed");
