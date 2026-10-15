import { Cookie, CookieMap } from "bun";

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
}
function throws(callback, message) {
  try { callback(); } catch (error) {
    if (!error.message.includes(message)) throw error;
    return;
  }
  throw new Error("Expected error: " + message);
}

const c = new Cookie("session", "hello \uD800读", {
  domain: ".example.com", path: "/app", expires: new Date(0), maxAge: 3600,
  secure: true, httpOnly: true, partitioned: true, sameSite: "strict",
});
equal(c.name, "session");
equal(c.value, "hello \uFFFD读");
equal(c.serialize(), "session=hello%20%EF%BF%BD%E8%AF%BB; Domain=.example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600; Secure; HttpOnly; Partitioned; SameSite=Strict");
equal(c.isExpired(), false);
c.maxAge = 0;
equal(c.isExpired(), true);
c.name = "ignored";
equal(c.name, "session");
c.sameSite = "NONE";
equal(c.sameSite, "none");
c.expires = 1234567890.5;
equal(c.expires.getTime(), 1234567890500);
c.expires.setTime(1);
equal(c.expires.getTime(), 1234567890500);
equal(Object.getPrototypeOf(c.toJSON()), null);
throws(() => new Cookie("bad name", "v"), "Invalid cookie name");
throws(() => c.domain = "EXAMPLE.COM", "Invalid cookie domain");
throws(() => c.path = "/;injected", "Invalid cookie path");
throws(() => new Cookie("a", "b", { sameSite: "Lax" }), "Invalid sameSite");
throws(() => Cookie.from("a", "b", { expires: NaN }), "expires must be a valid Number");
throws(() => new Cookie({ name: "a", expires: new Date(NaN) }), "expires must be a valid Date");
throws(() => Cookie.parse("a=b\r\nSet-Cookie: bad=x"), "valid HTTP header");
throws(() => Cookie.parse("a=读"), "valid HTTP header");
equal(Cookie.parse("a=b; MAX-AGE=2; max-age=3junk; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/a; Path=/b; DOMAIN=Example.COM; Secure=false; HttpOnly; Partitioned=0; SameSite=Strict").toString(),
  "a=b; Domain=example.com; Path=/b; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=3; Secure; HttpOnly; Partitioned; SameSite=Strict");
console.log("Cookie parsing, validation, mutation and serialization pass");

const map = new CookieMap("a=old; plain=%E8%AF%BB; __%48ost-session=literal; __Host-session=protected; empty=; a=duplicate");
equal(map.size, 6);
equal(map.get("a"), "old");
equal(map.get("plain"), "读");
equal(map.get("__%48ost-session"), "literal");
equal(map.get("__Host-session"), "protected");
equal(map.get("empty"), "");
equal(map.toSetCookieHeaders(), []);
map.set("a", "new");
map.set({ name: "added", value: "读", path: "" });
map.delete("__Host-session");
map.set("a", "latest");
equal(map.toSetCookieHeaders(), [
  "added=%E8%AF%BB; SameSite=Lax",
  "__Host-session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax",
  "a=latest; Path=/; SameSite=Lax",
]);
equal(Array.from(map.keys()), ["added", "a", "plain", "__%48ost-session", "empty"]);
equal(map.get("__Host-session"), null);
const reference = new Cookie("ref", "one");
map.set(reference);
reference.value = "two";
equal(map.get("ref"), "two");
equal(new CookieMap({ a: "%20" }).get("a"), "%20");
equal(new CookieMap([["a", "%20"]]).get("a"), "%20");
equal(new CookieMap("a=%20; b=café%20au%20lait").get("b"), "café au lait");
equal(new CookieMap("a=%1").get("a"), "\uFFFD1");
const pollute = new CookieMap("__proto__=safe; constructor=value; 0=first").toJSON();
equal(Object.getPrototypeOf(pollute), Object.prototype);
equal(pollute.__proto__, "safe");
equal(pollute.constructor, "value");
throws(() => new CookieMap([["one"]]), "exactly two strings");
throws(() => map.delete({}), "Cookie name is required");
console.log("CookieMap headers, literals, decoding, changes and identity pass");

const live = new CookieMap();
for (let i = 0; i < 20; i++) live.set("key" + i, "v");
for (const key of live.keys()) live.delete(key);
equal(live.size, 10);
const original = new CookieMap(Array.from({ length: 20 }, (_, i) => ["key" + i, "v"]));
for (const key of original.keys()) original.delete(key);
equal(original.size, 0);
class CustomCookie extends Cookie {}
class CustomMap extends CookieMap {}
equal(new CustomCookie("a", "b") instanceof CustomCookie, true);
equal(new CustomMap("a=b") instanceof CustomMap, true);
function Target() {}
const reflected = Reflect.construct(Cookie, ["a", "b"], Target);
equal(Cookie.prototype.serialize.call(reflected), "a=b; Path=/; SameSite=Lax");
const reflectedMap = Reflect.construct(CookieMap, ["a=b"], Target);
equal(CookieMap.prototype.get.call(reflectedMap, "a"), "b");
console.log("CookieMap iteration and subclassing pass");
