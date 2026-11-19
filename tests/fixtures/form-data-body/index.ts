// Body.formData() and Blob.formData() parse multipart/form-data and
// application/x-www-form-urlencoded bodies; a FormData body serializes as multipart.
function show(form: FormData): string {
  return JSON.stringify(Array.from(form, ([name, value]) =>
    typeof value === "string" ? [name, value] : [name, { file: value.name, type: value.type, size: value.size }]));
}

async function parse(label: string, contentType: string | null, body: string | Uint8Array) {
  const headers: Record<string, string> = contentType === null ? {} : { "content-type": contentType };
  const response = new Response(body, { headers });
  try {
    console.log(label, show(await response.formData()), "used", response.bodyUsed);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, "rejects", e.constructor.name, e.code, JSON.stringify(e.message), "used", response.bodyUsed);
  }
}

const crlf = (lines: string[]) => lines.join("\r\n");

await parse("text entry", "multipart/form-data; boundary=abc123",
  crlf(["--abc123", 'Content-Disposition: form-data; name="metadata"', "", '{"ok":true}\n', "--abc123--", ""]));
await parse("no entries", "multipart/form-data; boundary=def456", "--def456--");
await parse("file entry", "multipart/form-data; boundary=--456789", crlf([
  "----456789", 'Content-Disposition: form-data; name="file"; filename="index.html"',
  "Content-Type: text/html;charset=utf-8", "", "<html><body><h1>Hello</h1></body></html>\n", "----456789--", ""]));
await parse("rfc5987 filename", "multipart/form-data; boundary=--abcdefg", crlf([
  "----abcdefg", "Content-Disposition: form-data; name=\"emoji\"; filename*UTF-8''%F0%9F%9A%80.js",
  "Content-Type: application/javascript;charset=utf-8", "", 'console.log("🚀");\n', "----abcdefg--", ""]));
await parse("unquoted name", "multipart/form-data; boundary=--123456", crlf([
  "----123456", "Content-Disposition: form-data; name=value", "Content-Type: text/plain", "", "goodbye", "----123456--", ""]));
await parse("non-ascii name", "multipart/form-data; boundary=----formdata-undici-0.62",
  crlf(["------formdata-undici-0.62", 'Content-Disposition: form-data; name="fiŝo"', "", "value1", "------formdata-undici-0.62--"]));
await parse("case and bom", "Multipart/Form-Data; Boundary=q",
  crlf(["--q", "content-disposition: FORM-DATA; NAME=a", "", "﻿v", "--q--"]));
await parse("quoted boundary and escape", 'multipart/form-data; charset=utf-8; boundary="q"',
  crlf(["--q", 'Content-Disposition: form-data; name="a\\"b"; filename="x.json"', "", "{}", "--q--"]));
await parse("type from extension", "multipart/form-data; boundary=q",
  crlf(["--q", 'Content-Disposition: form-data; name="a"; filename="dir/pic.PNG"', "", "zz", "--q", 'Content-Disposition: form-data; name="b"; filename="noext"', "", "zz", "--q--"]));
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
await parse("sniffed type", "multipart/form-data; boundary=q", new Uint8Array(Array.from(new TextEncoder().encode(
  crlf(["--q", 'Content-Disposition: form-data; name="img"; filename="blob"', "", ""]))).concat(Array.from(png), Array.from(new TextEncoder().encode("\r\n--q--")))));
await parse("binary file", "multipart/form-data; boundary=q", new Uint8Array(Array.from(new TextEncoder().encode(
  crlf(["--q", 'Content-Disposition: form-data; name="bin"; filename="x.bin"', "Content-Type: application/octet-stream", "", ""]))).concat([0, 255, 13, 10, 0], Array.from(new TextEncoder().encode("\r\n--q--")))));
await parse("nameless part", "multipart/form-data; boundary=q", crlf(["--q", "Content-Type: text/plain", "", "v", "--q--"]));
await parse("preamble", "multipart/form-data; boundary=q", crlf(["ignored", "--q", 'Content-Disposition: form-data; name="a"', "", "1", "--q--", "epilogue"]));

await parse("urlencoded", "application/x-www-form-urlencoded", "ok=true&name=bun");
await parse("urlencoded empty", "application/x-www-form-urlencoded", "");
await parse("urlencoded utf-8", "application/x-www-form-urlencoded;charset=utf-8", "emoji=%F0%9F%8F%B3%EF%B8%8F%E2%80%8D%F0%9F%8C%88");
await parse("urlencoded details", "application/x-www-form-urlencoded", "﻿a=1&b=%20+x&&c&=d");

await parse("no content type", null, "a=1");
await parse("text/plain", "text/plain", "how are you?");
await parse("no boundary", "multipart/form-data", crlf(["--abc123", 'Content-Disposition: form-data; name="value"', "", "hello", "--abc123--", ""]));
await parse("empty boundary", "multipart/form-data; boundary=", "--x--");
await parse("malformed boundary", "multipart/form-data; boundary=abc123", crlf(["--", 'Content-Disposition: form-data; name="value"', "", '{"ok":true}\n', "----", ""]));
await parse("missing header end", "multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data; name=a\r\n--x--");
await parse("missing colon", "multipart/form-data; boundary=x", "--x\r\nabc\r\n\r\nv\r\n--x--");
await parse("boundary too long", `multipart/form-data; boundary=${"a".repeat(73)}`, "--x--");

// A used body reports that first.
const used = new Response("a=1", { headers: { "content-type": "text/plain" } });
await used.text();
await used.formData().catch((error: Error) => console.log("used body", error.constructor.name));

// Request bodies go through the same parser.
const request = new Request("http://localhost/", { method: "POST", body: new URLSearchParams({ x: "1", y: "two words" }) });
console.log("request urlencoded", show(await request.formData()));

// A FormData body is multipart with a WebKit-style boundary, and parses back.
const form = new FormData();
form.append("field1", "value1\nline2");
form.append('na"m\ne', "v");
form.append("file", new File(["example\ntext file"], "a/b/c/foo.txt", { type: "text/plain" }));
form.append("json", new Blob(["[]"], { type: "application/json" }), "second.json");
form.append("untyped", new File(["z"], 'fi"le\r\n.bin'));
const response = new Response(form);
const contentType = response.headers.get("content-type")!;
const boundary = contentType.split("boundary=")[1]!;
console.log("content type", contentType.replace(boundary, "<boundary>"), /^----WebKitFormBoundary[0-9a-f]{32}$/.test(boundary));
const text = await response.clone().text();
console.log("serialized", JSON.stringify(text.replaceAll(boundary, "<boundary>")));
console.log("round trip", show(await response.formData()));
const empty = await new Response(new FormData()).text();
console.log("empty form", JSON.stringify(empty.replace(/----WebKitFormBoundary[0-9a-f]{32}/, "<boundary>")));

// Blob.formData() reads the Blob's own type.
console.log("blob urlencoded", show(await new Blob(["a=1&b=2"], { type: "application/x-www-form-urlencoded" }).formData()));
await new Blob(["a=1"]).formData().catch((error: Error) => console.log("blob untyped", error.constructor.name, error.message));
await new Blob(["--x"], { type: "multipart/form-data; boundary=x" }).formData()
  .catch((error: Error) => console.log("blob malformed", error.constructor.name, error.message));
