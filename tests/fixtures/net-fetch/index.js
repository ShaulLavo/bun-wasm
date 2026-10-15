// fetch against the local test server (tests/servers/http.ts).
const base = process.env.TEST_SERVER;
const strip = (s) => s.replaceAll(base, "<server>");

const text = await fetch(`${base}/text`);
console.log("text:", text.status, text.ok, text.headers.get("content-type"), await text.text());
console.log("json:", JSON.stringify(await (await fetch(`${base}/json`)).json()));
const echo = await fetch(`${base}/echo?q=1`, {
  method: "POST",
  headers: { "x-test": "abc", "content-type": "text/plain" },
  body: "posted body",
});
console.log("echo:", JSON.stringify(await echo.json()));
console.log("put json:", (await (await fetch(`${base}/echo`, { method: "PUT", body: JSON.stringify({ a: 1 }) })).json()).body);
const bytes = new Uint8Array(await (await fetch(`${base}/bytes`)).arrayBuffer());
console.log("bytes:", Array.from(bytes).join(","));
console.log("gzip:", (await (await fetch(`${base}/gzip`)).text()).length);
const redirected = await fetch(`${base}/redirect`);
console.log("redirect:", redirected.status, redirected.redirected, strip(redirected.url), await redirected.text());
const manual = await fetch(`${base}/redirect`, { redirect: "manual" });
console.log("manual redirect:", manual.status, manual.headers.get("location"));
const teapot = await fetch(`${base}/status`);
console.log("status:", teapot.status, teapot.statusText, teapot.ok, teapot.headers.get("x-custom"));
const head = await fetch(`${base}/text`, { method: "HEAD" });
console.log("head:", head.status, (await head.text()).length);
const [a, b] = await Promise.all([fetch(`${base}/slow`).then((r) => r.text()), fetch(`${base}/text`).then((r) => r.text())]);
console.log("parallel:", a, "|", b);
const stream = (await fetch(`${base}/text`)).body;
let streamed = "";
for await (const chunk of stream) streamed += new TextDecoder().decode(chunk);
console.log("body stream:", streamed);
try {
  await fetch("http://127.0.0.1:9/");
} catch (err) {
  console.log("refused:", err instanceof Error, typeof err.message);
}
const ac = new AbortController();
const pending = fetch(`${base}/slow`, { signal: ac.signal });
ac.abort();
try {
  await pending;
} catch (err) {
  console.log("aborted:", err.name);
}
