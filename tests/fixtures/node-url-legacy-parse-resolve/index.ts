import url from "node:url";

const fields = (value: unknown) => JSON.stringify(Object.assign({}, value));

// The authority decision uses the whole string, query and fragment included.
const inputs = [
  "//a#b@c",
  "//a@b@c/z",
  "//a/b@c",
  "//a?b@c",
  "//user:pass@example.com:8000/foo/bar?baz=quux#frag",
  "mailto:foo@bar.com?subject=hello",
  "javascript://x/y",
  "http://a.com",
  "foo:bar",
  "//host",
  "\\\\a@b/c",
  "  http://x/y  ",
  "x://y#z",
  "file:///etc/passwd",
  "HTTP://EX.com/A b",
  "a:b@c",
  "/just/a/path?x=1",
];
for (const input of inputs) {
  for (const [label, args] of [["plain", [input]], ["query", [input, true]], ["slashes", [input, false, true]]] as const) {
    try {
      console.log("parse", label, JSON.stringify(input), fields((url.parse as (...args: unknown[]) => unknown)(...args)));
    } catch (error) {
      console.log("parse", label, JSON.stringify(input), "threw", (error as Error).name);
    }
  }
}

const resolves: [string, string][] = [
  ["mailto:a@b", "mailto:c@d"],
  ["http://a/b/c/d", "../e"],
  ["http://a/b/c/d", "?q"],
  ["http://a/b", "//x/y"],
  ["http://a/b", "https:z"],
  ["constructor://u@h:81/aa/bb?q#f", "../cc"],
  ["http://nodejs.org/", "jAvascript:alert(1);a='@white-listed.com'"],
  ["a:b", "c"],
  ["http://a/b/c", ""],
  ["http://a/b/c", "#h"],
  ["file:///a/b", "../c"],
  ["x:y@z/p", "../q"],
  ["http://a/b/c", "foo:bar"],
  ["foo://h/a/b", "../c"],
  ["http://a/b", "http:c"],
  ["mailto:local1@domain1", "local2@domain2"],
];
for (const [from, to] of resolves) {
  console.log("resolveObject", JSON.stringify(from), JSON.stringify(to), fields(url.parse(from, false, true).resolveObject(to)));
  console.log("resolve", JSON.stringify(from), JSON.stringify(to), url.parse(from, false, true).resolve(to));
  console.log("url.resolveObject", JSON.stringify(from), JSON.stringify(to), fields(url.resolveObject(from, to)));
}
console.log("url.resolveObject of an empty source", url.resolveObject("", "a"));
