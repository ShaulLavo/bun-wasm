const enc = new TextEncoder();
const bytes = enc.encode("héllo €");
console.log("TextEncoder:", bytes.length, Array.from(bytes.slice(0, 3)).join(","));
console.log("TextDecoder:", new TextDecoder().decode(bytes));
const dest = new Uint8Array(4);
console.log("encodeInto:", JSON.stringify(enc.encodeInto("aé€", dest)));
const streaming = new TextDecoder();
console.log("stream decode:", streaming.decode(bytes.slice(0, 2), { stream: true }) + streaming.decode(bytes.slice(2)));

const url = new URL("https://user:pw@example.com:8080/a/b/../c?x=1&y=two#frag");
console.log("URL:", url.href);
console.log("URL parts:", [url.protocol, url.username, url.password, url.host, url.hostname, url.port, url.pathname, url.search, url.hash, url.origin].join(" "));
url.searchParams.append("z", "a b&c");
url.pathname = "/new path";
url.hash = "";
console.log("URL mutated:", url.toString());
console.log("URL relative:", new URL("../up?q", "http://h.com/a/b/c").href);
console.log("URL.canParse:", URL.canParse("nope"), URL.canParse("data:text/plain,hi"));
try {
  new URL("not a url");
} catch (err) {
  console.log("URL invalid:", err.name, err.code);
}
const params = new URLSearchParams("a=1&b=2&a=3");
params.set("b", "x y");
params.sort();
console.log("URLSearchParams:", params.toString(), params.getAll("a").join("|"), params.has("b"), params.size);
console.log("from object:", new URLSearchParams({ q: "1+1=2", e: "é" }).toString());

console.log("btoa:", btoa("hello world"), "atob:", atob("aGVsbG8gd29ybGQ="));
try {
  btoa("€");
} catch (err) {
  console.log("btoa throws:", err.name);
}

const orig = { a: [1, { b: new Date(0) }], m: new Map([["k", new Set([1, 2])]]), re: /x/g };
orig.self = orig;
const clone = structuredClone(orig);
console.log("structuredClone:", clone !== orig, clone.self === clone, clone.a[1].b instanceof Date, clone.m.get("k").has(2), clone.re.source);
try {
  structuredClone(() => {});
} catch (err) {
  console.log("structuredClone fn:", err.name);
}

console.log("performance.now:", typeof performance.now(), performance.now() >= 0, typeof performance.timeOrigin);
const rnd = crypto.getRandomValues(new Uint8Array(16));
console.log("getRandomValues:", rnd.length, rnd instanceof Uint8Array);
console.log("randomUUID:", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()));

const target = new EventTarget();
target.addEventListener("ping", (e) => console.log("event:", e.type, e instanceof Event, e.detail));
target.addEventListener("ping", () => console.log("once listener"), { once: true });
target.dispatchEvent(new CustomEvent("ping", { detail: 42 }));
target.dispatchEvent(new CustomEvent("ping", { detail: 43 }));

const ac = new AbortController();
ac.signal.onabort = () => console.log("onabort fired, aborted:", ac.signal.aborted);
ac.abort();
console.log("abort reason:", ac.signal.reason.name);
console.log("AbortSignal.abort:", AbortSignal.abort("why").reason);

const blob = new Blob(["ab", new Uint8Array([99]), "d"], { type: "text/plain" });
console.log("Blob:", blob.size, blob.type);

const headers = new Headers({ "Content-Type": "text/html", "X-B": "2" });
headers.append("x-a", "1");
headers.append("X-A", "again");
console.log("Headers:", JSON.stringify(Array.from(headers.entries())), headers.get("content-type"), headers.has("X-b"));

const res = new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
console.log("Response:", res.status, res.ok, res.statusText === "", res.headers.get("content-type"));
const req = new Request("https://example.com/api", { method: "post", body: "payload" });
console.log("Request:", req.method, req.url);

(async () => {
  console.log("blob text:", await blob.text());
  console.log("response json:", JSON.stringify(await res.json()), res.bodyUsed);
  console.log("request text:", await req.text());
  console.log("Response.json:", await Response.json({ a: 1 }).text());
  console.log("arrayBuffer:", (await new Response("xyz").arrayBuffer()).byteLength);
})();
