import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

// A body made from a Bun.file() stays the file: it is read when the body is used, a clone keeps
// the file (and its type) instead of teeing it, and new Request(request) copies the body.
const dir = mkdtempSync("file-bodies-");
const fresh = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};
const firstLine = (value: unknown) => Bun.inspect(value).split("\n")[0];

{
  const path = fresh("grow.txt", "12345");
  const original = new Response(Bun.file(path));
  const clone = original.clone();
  writeFileSync(path, "123456789");
  console.log("both bodies see a file that grew:", JSON.stringify(await Promise.all([original.body, clone.body].map(body => Bun.readableStreamToText(body!)))));
}

for (const [label, make, change] of [
  ["whole", (path: string) => Bun.file(path), () => {}],
  ["slice", (path: string) => Bun.file(path).slice(1, 4), () => {}],
  ["grew", (path: string) => Bun.file(path), (path: string) => writeFileSync(path, "123456789")],
  ["deleted", (path: string) => Bun.file(path), (path: string) => unlinkSync(path)],
] as const) {
  const path = fresh(`label-${label}.txt`, "12345");
  const clone = new Response(make(path)).clone();
  change(path);
  console.log("inspect", label, firstLine(clone), "|", firstLine(clone));
}

{
  const path = fresh("page.html", "<p>hi</p>");
  for (const [label, make] of [
    ["Response over Bun.file().stream()", () => new Response(Bun.file(path).stream())],
    ["Request over Bun.file().stream()", () => new Request("http://example.com/", { method: "POST", body: Bun.file(path).stream() })],
    ["Response over Bun.file() after .body", () => {
      const response = new Response(Bun.file(path));
      void response.body;
      return response;
    }],
  ] as const) {
    const original = make();
    const clone = original.clone();
    const [a, b] = await Promise.all([original.blob(), clone.blob()]);
    const header = label.includes("stream()") ? original.headers.get("content-type") : "<not compared>";
    console.log(label, JSON.stringify({ header, original: [a.type, await a.text()], clone: [b.type, await b.text()] }));
  }
  const stream = Bun.file(path).stream();
  const response = new Response(stream);
  const clone = response.clone();
  console.log("given stream after clone:", stream.locked, response.body !== stream, JSON.stringify(await Promise.all([response.text(), clone.text()])));

  await using server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") {
        const framing = req.headers.get("content-length") ? `content-length ${req.headers.get("content-length")}` : `transfer-encoding ${req.headers.get("transfer-encoding")}`;
        return new Response(`${framing} ${req.headers.get("content-type")} ${await req.text()}`);
      }
      return new URL(req.url).pathname === "/clone" ? new Response(Bun.file(path).stream()).clone() : new Response(Bun.file(path).stream());
    },
  });
  for (const pathname of ["/direct", "/clone"]) {
    const res = await fetch(new URL(pathname, server.url));
    console.log("Bun.serve", pathname, res.headers.get("content-type"), res.headers.get("content-length"), await res.text());
  }
  // A Bun.file() uploads with a Content-Length; a stream over one is sent chunked.
  for (const [label, body] of [["Bun.file()", () => Bun.file(path)], ["Bun.file().stream()", () => Bun.file(path).stream()]] as const) {
    const res = await fetch(server.url, { method: "POST", body: body() });
    console.log("upload", label, await res.text());
  }
}

// new Request(src, init) copies the body: both the new request and its source read the bytes.
{
  const stream = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  const make = () => new Request("http://example.com/", { method: "POST", body: stream(), duplex: "half" } as RequestInit);
  const bytes = async (r: Request | Response) => JSON.stringify(Array.from(new Uint8Array(await r.arrayBuffer())));
  const twoArgSrc = make();
  const twoArg = new Request(twoArgSrc, { headers: { "x-a": "1" } });
  const oneArgSrc = make();
  const oneArg = new Request(oneArgSrc);
  console.log("source after new Request(src):", oneArgSrc.bodyUsed, oneArgSrc.body?.locked);
  const responseSrc = new Response(stream(), { headers: { "x-r": "1" } });
  const fromResponse = new Request("http://example.com/", responseSrc as any);
  console.log("Request(url, response):", fromResponse.method, JSON.stringify(Array.from(fromResponse.headers)));
  console.log("bodies:", await bytes(twoArg), await bytes(twoArgSrc), await bytes(oneArg), await bytes(oneArgSrc), await bytes(fromResponse), await bytes(responseSrc));
  const path = fresh("request-response.txt", "12345");
  new Request("http://example.com/", new Response(Bun.file(path)) as any);
  writeFileSync(path, "123456789");
  console.log("the file after Request(url, response):", Bun.file(path).size, await Bun.readableStreamToText(new Response(Bun.file(path)).body!));
}

// A body that cannot be read is cloned without reading it; each read fails on its own.
{
  const codes = async (file: Bun.BunFile) => {
    const original = new Response(file);
    const clone = original.clone();
    return JSON.stringify((await Promise.allSettled([original.text(), clone.text()])).map(r => (r.status === "rejected" ? r.reason?.code : r.status)));
  };
  const directory = join(dir, "sub");
  mkdirSync(directory);
  const fd = openSync(directory, "r");
  console.log("directory by path:", await codes(Bun.file(directory)), "by descriptor:", await codes(Bun.file(fd)), "closed descriptor:", await codes(Bun.file(1_000_000)));
  closeSync(fd);
  const error = await Bun.file(directory).text().catch(e => e);
  console.log("directory read:", error.name, error.code, error.syscall, JSON.stringify(error.message));
  console.log("missing file body:", firstLine(new Response(Bun.file(join(dir, "missing")))), await new Response(Bun.file(join(dir, "missing"))).text().catch(e => e.code));
}

// A file given by descriptor can be read only once, so a clone is teed: both bodies get the bytes.
{
  const path = fresh("descriptor.txt", "hello world");
  for (const [label, make] of [
    ["Bun.file(fd)", (fd: number) => Bun.file(fd)],
    ["Bun.file(fd).stream()", (fd: number) => Bun.file(fd).stream()],
    ["new Blob([Bun.file(fd)])", (fd: number) => new Blob([Bun.file(fd)])],
  ] as const) {
    const fd = openSync(path, "r");
    const original = new Response(make(fd));
    const clone = original.clone();
    console.log("descriptor body", label, JSON.stringify(await Promise.all([original.text(), clone.text()])));
    closeSync(fd);
  }
}
