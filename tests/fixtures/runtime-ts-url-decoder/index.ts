import { StringDecoder } from "node:string_decoder";
import * as url from "node:url";

function attempt(label: string, run: () => unknown) {
  try {
    console.log(label, JSON.stringify(run()));
  } catch (error) {
    const { name, code, message } = error as { name: string; code?: string; message: string };
    console.log(label, "throws", name, code, message);
  }
}

function feed(encoding: string, chunks: number[][]) {
  const decoder = new StringDecoder(encoding);
  const parts = chunks.map(chunk => [decoder.write(Buffer.from(chunk)), decoder.lastNeed, decoder.lastTotal]);
  return [parts, decoder.end()];
}

const euro = [0xe2, 0x82, 0xac];
const smile = [0xf0, 0x9f, 0x98, 0x80];
attempt("utf8 split 3", () => feed("utf8", [euro.slice(0, 1), euro.slice(1, 2), euro.slice(2)]));
attempt("utf8 split 4", () => feed("utf-8", [smile.slice(0, 2), smile.slice(2)]));
attempt("utf8 bad continuation", () => feed("utf8", [[0xe2, 0x82], [0x41, 0x42]]));
attempt("utf8 truncated end", () => feed("utf8", [[0x41, 0xf0, 0x9f]]));
attempt("utf8 lone continuation", () => feed("utf8", [[0x80, 0x80, 0x41]]));
attempt("utf16le odd", () => feed("utf16le", [[0x41], [0x00, 0x42], [0x00]]));
attempt("utf16le surrogate", () => feed("ucs2", [[0x3d, 0xd8], [0x00, 0xde]]));
attempt("utf16le dangling surrogate", () => feed("utf-16le", [[0x3d, 0xd8, 0x00]]));
attempt("base64 groups", () => feed("base64", [[0x66], [0x6f, 0x6f, 0x62], [0x61]]));
attempt("base64url groups", () => feed("base64url", [[0xfb, 0xff], [0xfe]]));
attempt("hex", () => feed("hex", [[0x01, 0xab], [0xff]]));
attempt("latin1", () => feed("binary", [[0xe9, 0x41]]));
attempt("ascii", () => feed("ascii", [[0x41, 0xc3]]));
attempt("default encoding", () => new StringDecoder().encoding);
attempt("null encoding", () => new StringDecoder(null as unknown as string).encoding);
attempt("upper encoding", () => new StringDecoder("UTF-16LE").encoding);
attempt("unknown encoding", () => new StringDecoder("klingon"));
attempt("write string", () => new StringDecoder("hex").write("as-is" as unknown as Buffer));
attempt("write view", () => new StringDecoder().write(new DataView(new Uint8Array([0x68, 0x69]).buffer) as unknown as Buffer));
attempt("write number", () => new StringDecoder().write(7 as unknown as Buffer));
attempt("write object", () => new StringDecoder().write({} as unknown as Buffer));
attempt("write null", () => new StringDecoder().write(null as unknown as Buffer));
attempt("end chunk", () => { const decoder = new StringDecoder(); decoder.write(Buffer.from(euro.slice(0, 2))); return decoder.end(Buffer.from(euro.slice(2))); });
attempt("text offset", () => new StringDecoder().text(Buffer.from([0x41, 0x42, 0x43]), 1));
console.log("--- url");
attempt("fileURLToPath", () => url.fileURLToPath("file:///tmp/a%20b%23c.txt"));
attempt("fileURLToPath URL", () => url.fileURLToPath(new URL("file://localhost/x/y")));
attempt("fileURLToPath scheme", () => url.fileURLToPath("http://a/b"));
attempt("fileURLToPath host", () => url.fileURLToPath("file://remote/b"));
attempt("fileURLToPath slash", () => url.fileURLToPath("file:///a%2Fb"));
attempt("pathToFileURL", () => url.pathToFileURL("/tmp/a b%c\\d\te").href);
attempt("pathToFileURL slash", () => url.pathToFileURL("/tmp/dir/").href);
attempt("parse full", () => url.parse("https://user:pw@Host.com:8080/p/a?x=1&y=2#frag"));
attempt("parse query", () => url.parse("http://h/p?x=1&x=2", true).query);
attempt("parse empty query", () => url.parse("http://h/p", true).query);
attempt("parse relative", () => url.parse("/just/a/path?q"));
attempt("parse slashes host", () => url.parse("//host/path", false, true).host);
attempt("parse slashes plain", () => url.parse("//host/path").pathname);
attempt("parse mailto", () => url.parse("mailto:someone@example.com").href);
attempt("parse type", () => url.parse(7 as unknown as string));
attempt("format object", () => url.format({ protocol: "https", hostname: "example.com", port: "8443", pathname: "x y", query: { a: "1", b: "2" }, hash: "h" }));
attempt("format search", () => url.format({ protocol: "http:", host: "a.com", search: "q=1", pathname: "/p?#" }));
attempt("format file", () => url.format({ protocol: "file", pathname: "/etc/hosts" }));
attempt("format string", () => url.format("HTTP://Example.com/a"));
attempt("format URL options", () => url.format(new URL("https://u:p@a.com/p?q#h"), { auth: false, fragment: false, search: false }));
attempt("resolve", () => [url.resolve("http://a.com/b/c", "../d"), url.resolve("/one/two", "three"), url.resolve("http://a.com/", "//b.com/x")]);
attempt("resolveObject", () => url.resolveObject("http://a.com/b/", "c?d").href);
attempt("domainToASCII", () => [url.domainToASCII("español.com"), url.domainToASCII("xn--iñvalid.com")]);
attempt("domainToUnicode", () => url.domainToUnicode("example.com"));
attempt("urlToHttpOptions", () => url.urlToHttpOptions(new URL("http://u%20x:p@[::1]:81/a?b#c")));
attempt("urlToHttpOptions plain", () => url.urlToHttpOptions(new URL("https://example.com/")));

console.log("--- url parity");
const fileInputs = [7, null, undefined, true, {}, { href: "file:///tmp/a" }];
for (const input of fileInputs) {
  attempt("fileURLToPath boundary " + String(input), () => url.fileURLToPath(input as string));
}
attempt("fileURLToPath invalid URL", () => url.fileURLToPath("not a URL"));
attempt("fileURLToPath backslash", () => url.fileURLToPath("file:///a%5Cb"));
attempt("fileURLToPath unicode", () => url.fileURLToPath("file:///caf%C3%A9"));
attempt("format query array", () => url.format({ pathname: "/", query: { a: "1", b: ["2", "3"] } }));
attempt("format query encoding", () => url.format({ pathname: "/", query: { a: "a b~!()'", empty: [] } }));
attempt("format query values", () => url.format({ pathname: "/", query: { nil: null, missing: undefined, yes: true, n: NaN, infinite: Infinity, object: { x: 1 } } }));
attempt("format query pairs", () => url.format({ pathname: "/", query: [["a", "1"], ["a", "2"]] }));
attempt("format query URLSearchParams", () => url.format({ pathname: "/", query: new URLSearchParams("a=1&a=2") }));
attempt("format query string ignored", () => url.format({ pathname: "/", query: "a=1" }));
attempt("format search wins", () => url.format({ pathname: "/", search: "?fixed", query: { a: ["1", "2"] } }));
attempt("format empty search", () => url.format({ pathname: "/", search: "", query: { a: ["1", "2"] } }));
const domains = ["xn--espaol-zwa.com", "xn--bcher-kva.de", "xn--fiqs8s", "español.com", "EXAMPLE.COM.", "xn--iñvalid.com", "xn--", "a b", "a/b", "a?b", "a#b", "user@xn--espaol-zwa.com", "foo:81", "127.0.0.1", "0x7f.1", "[::1]", "%65xample.com", "%E2%98%83.com", ""];
for (const domain of domains) {
  attempt("domainToUnicode " + JSON.stringify(domain), () => url.domainToUnicode(domain));
}
for (const domain of [null, undefined, 7, { toString: () => "xn--bcher-kva.de" }]) {
  attempt("domainToUnicode coercion " + String(domain), () => url.domainToUnicode(domain as string));
}
const coercionError = new Error("domain coercion failed");
attempt("domainToUnicode throwing coercion", () => {
  try { url.domainToUnicode({ toString() { throw coercionError; } } as unknown as string); }
  catch (error) { return error === coercionError; }
});
