import assert from "node:assert/strict";
import { parse, urlToHttpOptions } from "node:url";
import buffer, { resolveObjectURL } from "node:buffer";

async function main() {
  for (const [input, hostname, host] of [
    ["http://[::1]", "::1", "[::1]"],
    ["http://[2001:db8::1]:8080/a", "2001:db8::1", "[2001:db8::1]:8080"],
    ["http://💥.net", "xn--hs8h.net", "xn--hs8h.net"],
    ["http://xn--xample-hva.com", "xn--xample-hva.com", "xn--xample-hva.com"],
  ]) {
    const result = parse(input);
    assert.equal(result.hostname, hostname);
    assert.equal(result.host, host);
    assert.equal(parse(result.href!).hostname, hostname);
  }
  verifyLegacyHosts();
  const options = urlToHttpOptions(new URL("http://u%20n:p%40ss@[::1]:81/a?q#h"));
  assert.equal(Object.getPrototypeOf(options), null);
  assert.equal(options.hostname, "::1");
  assert.equal(options.port, 81);
  assert.equal(options.auth, "u n:p@ss");
  assert.equal(options.path, "/a?q");
  assert.throws(() => Reflect.construct(URL, []), { code: "ERR_MISSING_ARGS" });
  assert.throws(() => new URL("//[", "http://x"), { message: "Invalid URL", code: "ERR_INVALID_URL", input: "//[", base: "http://x" });
  const url = new URL("http://x");
  assert.throws(() => { url.href = "::"; }, { message: "Invalid URL", code: "ERR_INVALID_URL", input: "::" });
  try { new URL("::"); } catch (error) { assert.equal(Object.hasOwn(error!, "base"), false); }
  let conversions = 0;
  assert.throws(() => Reflect.construct(URL, [{ toString() { conversions++; return "::"; } }]), { code: "ERR_INVALID_URL" });
  assert.equal(conversions, 1);
  for (const method of [URL.canParse, URL.parse]) {
    assert.equal(method.length, 1);
    assert.throws(() => Reflect.apply(method, URL, []), { code: "ERR_MISSING_ARGS" });
    assert.throws(() => Reflect.apply(method, URL, [Symbol("url")]), TypeError);
  }
  for (const [input, origin] of [
    ["blob:file://text.txt", "file://text.txt"],
    ["blob:file:///folder/text.txt", "file://"],
    ["blob:file://localhost/a", "file://"],
    ["blob:file://host/a", "file://host"],
    ["blob:file://[bad]/a", "null"],
  ]) assert.equal(new URL(input).origin, origin);
  verifyQueryMutations();
  assert.equal(buffer.resolveObjectURL, resolveObjectURL);
  const blob = new Blob(["hello"], { type: "application/octet-stream" });
  const first = URL.createObjectURL(blob);
  const second = URL.createObjectURL(blob);
  assert.notEqual(first, second);
  const resolved = resolveObjectURL(first)!;
  assert(resolved instanceof Blob);
  assert.notEqual(resolved, blob);
  assert.notEqual(resolved, resolveObjectURL(first));
  assert.equal(resolved.type, blob.type);
  assert.equal(await resolved.text(), "hello");
  assert.equal(resolveObjectURL(first + "#fragment"), undefined);
  assert.equal(resolveObjectURL(first + "😀"), undefined);
  assert.equal(resolveObjectURL("énot-a-blob"), undefined);
  assert.equal(resolveObjectURL("😀not-a-blob"), undefined);
  assert.throws(() => URL.createObjectURL(Object.create(Blob.prototype)), TypeError);
  assert.throws(() => Reflect.apply(URL.createObjectURL, URL, [{}]), { code: "ERR_INVALID_ARG_TYPE" });
  const file = new File(["file"], "name.txt", { type: "application/octet-stream", lastModified: 123 });
  const fileURL = URL.createObjectURL(file);
  const resolvedFile = resolveObjectURL(fileURL);
  assert(resolvedFile instanceof File);
  assert.equal(resolvedFile.name, "name.txt");
  assert.equal(resolvedFile.lastModified, 123);
  const sentinel = new Error("coercion");
  const boxed = new String(first);
  boxed.toString = () => { throw sentinel; };
  assert.throws(() => Reflect.apply(URL.revokeObjectURL, URL, [boxed]), error => error === sentinel);
  assert.equal(URL.revokeObjectURL(first), undefined);
  assert.equal(URL.revokeObjectURL(first), undefined);
  assert.equal(resolveObjectURL(first), undefined);
  assert.equal(await resolved.text(), "hello");
  assert.equal(await resolveObjectURL(second)!.text(), "hello");
  URL.revokeObjectURL(second);
  URL.revokeObjectURL(fileURL);
  const swapped = new Blob(["hello"]);
  Object.setPrototypeOf(swapped, {});
  const swappedURL = URL.createObjectURL(swapped);
  assert.equal(await resolveObjectURL(swappedURL)!.text(), "hello");
  URL.revokeObjectURL(swappedURL);
  assert.throws(() => Reflect.apply(URL.revokeObjectURL, URL, []), {
    code: "ERR_MISSING_ARGS", message: "Not enough arguments to 'revokeObjectURL'. Expected 1, got 0.",
  });
  console.log("URL compatibility ok");
}

function verifyLegacyHosts() {
  for (const input of ["http://‍.com/a", "http://\ud800/a", "http://[::1/x", "http://[::1]x/p"]) {
    assert.throws(() => parse(input), { code: "ERR_INVALID_URL", message: "Invalid URL" }, input);
  }
  for (const [input, host, pathname, href] of [
    ["http://é%41.com/a", "xn--9ca", "%41.com/a", "http://xn--9ca/%41.com/a"],
    ["http://a b.com/x", "a", "%20b.com/x", "http://a/%20b.com/x"],
    ["http://exa<mple.com/", "exa", "%3Cmple.com/", "http://exa/%3Cmple.com/"],
    ["http:///x", "", "/x", "http:///x"],
    ["http://a@b?@c", "b", "/", "http://a@b/?@c"],
    ["http://a@b@c/", "c", "/", "http://a%40b@c/"],
    ["http://\tex\nample.com/", "example.com", "/", "http://example.com/"],
    ["http://a:b@ÉX.com:8080/p?q#h", "xn--x-9fa.com:8080", "/p", "http://a:b@xn--x-9fa.com:8080/p?q#h"],
    ["http://evil.com\\@good.com/", "evil.com", "/@good.com/", "http://evil.com/@good.com/"],
    ["http://x.com\\y\\z", "x.com", "/y/z", "http://x.com/y/z"],
    ["http://x.com/a?b\\c#d\\e", "x.com", "/a", "http://x.com/a?b%5Cc#d%5Ce"],
    ["http://x.com/a#b\\c?d", "x.com", "/a", "http://x.com/a#b%5Cc?d"],
  ]) {
    const result = parse(input);
    assert.deepEqual([result.host, result.pathname, result.href], [host, pathname, href], input);
  }
}

function verifyQueryMutations() {
  const u = new URL("http://h/?a=1&a=2");
  const p = u.searchParams;
  p.append("b", "3");
  assert.equal(u.href, "http://h/?a=1&a=2&b=3");
  p.append("c", "4");
  assert.equal(u.search, "?a=1&a=2&b=3&c=4");
  p.delete("a", "1");
  assert.equal(u.toString(), "http://h/?a=2&b=3&c=4");
  p.sort();
  assert.equal(u.origin, "http://h");
  assert.equal(u.toJSON(), "http://h/?a=2&b=3&c=4");
  p.append("drop", "x");
  u.search = "?z=1&z=2&a=3";
  assert.equal(u.searchParams, p);
  assert.deepEqual(Array.from(p), [["z", "1"], ["z", "2"], ["a", "3"]]);
  p.sort();
  p.append("z", "4");
  p.delete("z", "2");
  assert.equal(u.search, "?a=3&z=1&z=4");
  p.set("z", "5");
  assert.equal(u.href, "http://h/?a=3&z=5");
  const iterator = p.entries();
  assert.deepEqual(iterator.next().value, ["a", "3"]);
  u.href = "https://other/?first=1&second=2";
  assert.equal(u.searchParams, p);
  assert.deepEqual(iterator.next().value, ["second", "2"]);
  const sentinel = new Error("query coercion");
  assert.throws(() => Reflect.apply(p.set, p, [{ toString() {
    p.append("kept", "yes");
    throw sentinel;
  } }, "x"]), error => error === sentinel);
  assert.equal(u.href, "https://other/?first=1&second=2&kept=yes");
  Reflect.apply(p.append, p, [
    { toString() { u.search = "?r=3"; return "k"; } },
    { toString() { u.pathname = "/changed"; return "v"; } },
  ]);
  assert.equal(u.href, "https://other/changed?r=3&k=v");
  assert.throws(() => Reflect.set(u, "pathname", { toString() {
    p.append("during", "2");
    throw sentinel;
  } }), error => error === sentinel);
  assert.equal(u.href, "https://other/changed?r=3&k=v&during=2");
  Reflect.set(u, "pathname", { toString() {
    u.href = "https://reset/?fresh=1";
    p.append("kept", "2");
    return "/next";
  } });
  assert.equal(u.href, "https://reset/next?fresh=1&kept=2");
  assert.equal(p.toString(), "fresh=1&kept=2");
  const live = p.entries();
  assert.deepEqual(live.next().value, ["fresh", "1"]);
  p.append("last", "3");
  p.delete("kept");
  assert.deepEqual(live.next().value, ["last", "3"]);
  p.delete("fresh");
  p.delete("last");
  assert.equal(u.href, "https://reset/next");
  p.toString = () => { throw new Error("public serializer called"); };
  p.append("k", "v");
  assert.equal(u.href, "https://reset/next?k=v");
}

main();
