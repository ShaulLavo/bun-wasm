const url = require("url");
const crypto = require("crypto");
console.log("fileURLToPath:", url.fileURLToPath("file:///tmp/a%20b.txt"));
console.log("pathToFileURL:", url.pathToFileURL("/tmp/a b#c.txt").href);
const legacy = url.parse("https://user@host.com:8080/p/a/t/h?query=string#hash");
console.log("legacy parse:", legacy.protocol, legacy.auth, legacy.host, legacy.port, legacy.pathname, legacy.search, legacy.hash);
console.log("format:", url.format({ protocol: "https", hostname: "example.com", pathname: "/x", query: { a: 1 } }));
console.log("resolve:", url.resolve("http://a.com/b/c", "../d"));
console.log("md5:", crypto.createHash("md5").update("abc").digest("hex"));
console.log("sha1:", crypto.createHash("sha1").update("abc").digest("hex"));
console.log("sha256:", crypto.createHash("sha256").update("a").update("bc").digest("hex"));
console.log("sha512 base64:", crypto.createHash("sha512").update("abc").digest("base64").slice(0, 20));
console.log("hmac:", crypto.createHmac("sha256", "key").update("data").digest("hex"));
console.log("hash():", crypto.hash("sha1", "abc"));
console.log("randomBytes:", crypto.randomBytes(8).length, Buffer.isBuffer(crypto.randomBytes(1)));
console.log("randomUUID:", crypto.randomUUID().length, typeof crypto.randomInt(10));
console.log("timingSafeEqual:", crypto.timingSafeEqual(Buffer.from("a"), Buffer.from("a")));
crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")).then((d) => console.log("subtle.digest:", Buffer.from(d).toString("hex").slice(0, 16)));
try {
  crypto.createHash("nope");
} catch (err) {
  console.log("bad digest throws:", err instanceof Error);
}
