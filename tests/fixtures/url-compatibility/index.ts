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
  console.log("URL compatibility ok");
}

main();
