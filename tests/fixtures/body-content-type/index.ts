// Which Content-Type each body kind gets: none for strings and bytes when a Request or
// Response is built, a text type from blob(), and Bun.serve's defaults on the wire.
type Make = () => BodyInit | null;
const bodies: Array<[string, Make]> = [
  ["string", () => "x"],
  ["empty string", () => ""],
  ["number", () => 42 as unknown as BodyInit],
  ["URLSearchParams", () => new URLSearchParams("a=1")],
  ["typed Blob", () => new Blob(["x"], { type: "text/foo" })],
  ["ArrayBuffer", () => new ArrayBuffer(1)],
  ["Uint8Array", () => new Uint8Array([1, 2])],
  ["empty Uint8Array", () => new Uint8Array(0)],
  ["FormData", () => { const form = new FormData(); form.append("a", "1"); return form; }],
  ["ReadableStream", () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); c.close(); } })],
  ["null", () => null],
];
const shown = (value: string | null) => JSON.stringify(value && value.replace(/boundary=.*/, "boundary=<b>"));

console.log("== constructed");
for (const [name, make] of bodies) {
  const response = new Response(make());
  const post = make();
  const request = new Request("http://localhost/", post === null ? {} : { method: "POST", body: post });
  console.log(name, "response:", shown(response.headers.get("content-type")), "request:", shown(request.headers.get("content-type")));
}

console.log("== blob() type");
for (const [name, make] of bodies) {
  const post = make();
  const fromRequest = await new Request("http://localhost/", post === null ? {} : { method: "POST", body: post }).blob();
  const fromResponse = await new Response(make()).blob();
  const cloned = await new Response(make()).clone().blob();
  const line: Record<string, string> = { request: shown(fromRequest.type), response: shown(fromResponse.type), cloned: shown(cloned.type) };
  // A user stream's blob() ignores the header in Bun; this runtime keeps it, so streams are left out.
  if (name !== "ReadableStream") line.typed = shown((await new Response(make(), { headers: { "content-type": "a/b" } }).blob()).type);
  console.log(name, JSON.stringify(line));
}

console.log("== Bun.serve and fetch");
const served: Record<string, () => Response> = {
  string: () => new Response("x"),
  "empty string": () => new Response(""),
  "cloned string": () => new Response("x").clone(),
  number: () => new Response(42 as unknown as BodyInit),
  bytes: () => new Response(new Uint8Array([1, 2])),
  "typed Blob": () => new Response(new Blob(["x"], { type: "text/foo" })),
  "explicit type": () => new Response("x", { headers: { "content-type": "text/html" } }),
  json: () => Response.json({ a: 1 }),
  null: () => new Response(null),
  stream: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); c.close(); } })),
};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (path === "echo") return new Response(JSON.stringify(req.headers.get("content-type")));
    return served[path]();
  },
});
try {
  for (const name of Object.keys(served)) {
    const response = await fetch(new URL(`/${encodeURIComponent(name)}`, server.url));
    await response.arrayBuffer();
    console.log("served", name, JSON.stringify(response.headers.get("content-type")));
  }
  const echo = new URL("/echo", server.url);
  for (const [name, make] of bodies) {
    const body = make();
    if (body === null) continue;
    const sent = await (await fetch(echo, { method: "POST", body })).text();
    console.log("sent", name, shown(JSON.parse(sent)));
  }
  console.log("sent Request", await (await fetch(new Request(echo, { method: "POST", body: "x" }))).text());
} finally {
  server.stop(true);
}

console.log("== Headers toJSON");
const headers = new Headers([["zz", "1"], ["icy-metaint", "2"], ["x-temp-tablet", "3"], ["aa", "4"], ["set-cookie2", "5"], ["dnt", "6"], ["X-Custom", "7"], ["vary", "8"], ["set-cookie", "c"], ["Referer", "9"], ["52782", "n"]]);
headers.delete("icy-metaint");
headers.append("icy-metaint", "10");
headers.set("dnt", "11");
headers.append("zz", "12");
console.log(JSON.stringify(headers.toJSON()));
console.log(JSON.stringify(Array.from(headers.keys())));
console.log(JSON.stringify(new Headers({ "x-b": "1", "content-type": "t", accept: "a", "user-agent": "u" }).toJSON()));
console.log(JSON.stringify(new Headers().toJSON()));
