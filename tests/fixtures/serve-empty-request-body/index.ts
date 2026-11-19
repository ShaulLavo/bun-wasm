import { connect } from "node:net";
import { isDisturbed } from "node:stream";

// Bun.serve hands a handler req.body === null when the request carries no bytes:
// no body at all, Content-Length: 0, or a chunked body with no chunks. Like any
// missing body it is never used up, so req.text() can be called again.
// Answering HEAD with a string or byte Response whose .body was read still consumes
// that body: the stream ends locked and disturbed and bodyUsed is true.
const settled = (promise: Promise<unknown>) => promise.then(value => `ok ${JSON.stringify(value)}`, error => (error as Error).constructor.name);

async function describe(req: Request): Promise<string> {
  const body = req.body === null ? "null" : "stream";
  const first = await settled(req.text());
  const usedAfterFirst = req.bodyUsed;
  const second = await settled(req.text());
  return `body=${body} text=${first} used=${usedAfterFirst} again=${second} used=${req.bodyUsed}`;
}

const server = Bun.serve({ port: 0, fetch: async req => new Response(await describe(req)) });

function raw(head: string, body = ""): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = connect(server.port, "127.0.0.1", () => socket.write(`${head}\r\nHost: localhost\r\nConnection: close\r\n\r\n${body}`));
  let text = "";
  socket.setEncoding("latin1");
  socket.on("data", chunk => { text += chunk; });
  socket.on("end", () => resolve(text.slice(text.indexOf("\r\n\r\n") + 4)));
  socket.on("error", reject);
  return promise;
}

let sent: Response | undefined;
const sender = Bun.serve({ port: 0, fetch: () => sent! });
try {
  const rawCases: [string, string, string?][] = [
    ["POST with no body", "POST / HTTP/1.1"],
    ["POST with Content-Length: 0", "POST / HTTP/1.1\r\nContent-Length: 0"],
    ["PUT with Content-Length: 0", "PUT / HTTP/1.1\r\nContent-Length: 0"],
    ["DELETE with no body", "DELETE / HTTP/1.1"],
    ["PATCH with no body", "PATCH / HTTP/1.1"],
    ["POST chunked with no chunks", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked", "0\r\n\r\n"],
    ["POST chunked with one chunk", "POST / HTTP/1.1\r\nTransfer-Encoding: chunked", "2\r\nhi\r\n0\r\n\r\n"],
    ["POST with Content-Length: 2", "POST / HTTP/1.1\r\nContent-Length: 2", "hi"],
  ];
  for (const [name, head, body] of rawCases) console.log(`${name}: ${await raw(head, body)}`);

  const fetchCases: [string, RequestInit][] = [
    ["fetch POST with no body", { method: "POST" }],
    ['fetch POST with body ""', { method: "POST", body: "" }],
    ["fetch POST with an empty Uint8Array", { method: "POST", body: new Uint8Array(0) }],
    ["fetch DELETE with no body", { method: "DELETE" }],
    ['fetch POST with body "hi"', { method: "POST", body: "hi" }],
  ];
  for (const [name, init] of fetchCases) console.log(`${name}: ${await (await fetch(server.url, init)).text()}`);

  const bodies: [string, () => BodyInit][] = [
    ["string", () => "payload"],
    ["Uint8Array", () => new TextEncoder().encode("payload")],
  ];
  for (const [name, init] of bodies) {
    const owner = new Response(init());
    const stream = owner.body!;
    sent = owner;
    const answer = await fetch(sender.url, { method: "HEAD" });
    const text = await answer.text();
    console.log(`HEAD answered by a ${name} Response with .body read: status=${answer.status} length=${answer.headers.get("content-length")} text=${JSON.stringify(text)} locked=${stream.locked} disturbed=${isDisturbed(stream as never)} used=${owner.bodyUsed}`);
  }
  const untouched = new Response("payload");
  sent = untouched;
  const plain = await fetch(sender.url, { method: "HEAD" });
  console.log(`HEAD answered by an unread string Response: length=${plain.headers.get("content-length")} text=${JSON.stringify(await plain.text())} used=${untouched.bodyUsed}`);

  let cancelled = false;
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  const streamed = new Response(endless);
  sent = streamed;
  await (await fetch(sender.url, { method: "HEAD" })).text();
  await Bun.sleep(10);
  console.log(`HEAD answered by a ReadableStream Response: locked=${endless.locked} disturbed=${isDisturbed(endless as never)} used=${streamed.bodyUsed} cancelled=${cancelled}`);
} finally {
  server.stop(true);
  sender.stop(true);
}
