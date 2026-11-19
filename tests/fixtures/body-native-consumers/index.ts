import { isDisturbed, isErrored, isReadable, Readable } from "node:stream";

// fetch() uploading a Request, Bun.serve() sending a Response and clone() lifting an
// unread in-memory stream consume a body like a mixin method does: the body's stream
// ends closed, disturbed and locked. clone() of a used or locked body throws Bun's
// "Body is disturbed or locked".
const jsStream = (chunk: string) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
const sources: [string, () => BodyInit][] = [
  ["string", () => "payload"],
  ["Blob", () => new Blob(["payload"])],
  ["Uint8Array", () => new TextEncoder().encode("payload")],
  ["URLSearchParams", () => new URLSearchParams("a=1")],
  ["ReadableStream", () => jsStream("payload")],
  ['""', () => ""],
  ["Uint8Array(0)", () => new Uint8Array(0)],
  ["Blob([])", () => new Blob([])],
  ["async generator", () => (async function* () { yield new TextEncoder().encode("payload"); })() as unknown as BodyInit],
  ["node:stream Readable", () => Readable.from([Buffer.from("payload")]) as unknown as BodyInit],
];
const request = (body: BodyInit) => new Request("http://a/", { method: "POST", body, duplex: "half" } as RequestInit);
const errorName = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
};
const message = (fn: () => unknown) => {
  try {
    fn();
    return "no throw";
  } catch (error) {
    return `${(error as Error).constructor.name} ${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
};
const settled = (promise: Promise<unknown>) => promise.then(() => "ok", error => (error as Error).constructor.name);
const state = (stream: ReadableStream) => `readable=${isReadable(stream as never)} errored=${isErrored(stream as never)} disturbed=${isDisturbed(stream as never)} locked=${stream.locked}`;
async function consumed(owner: Request | Response, stream: ReadableStream, make: (body: BodyInit) => Request | Response): Promise<string> {
  return `${state(stream)} same=${owner.body === stream} used=${owner.bodyUsed} getReader=${errorName(() => stream.getReader())} rewrap=${errorName(() => make(stream))} again=${await settled(owner.text())} clone=${errorName(() => owner.clone())}`;
}

const echo = Bun.serve({ port: 0, fetch: async req => new Response(await req.text()) });
let sent: Response | undefined;
const sender = Bun.serve({ port: 0, fetch: () => sent! });
try {
  for (const [name, init] of sources) {
    const owner = request(init());
    const stream = owner.body!;
    const text = await (await fetch(echo.url, owner as RequestInit)).text();
    console.log(`Request ${name} .body then fetch(url, request): ${JSON.stringify(text)} ${await consumed(owner, stream, request)}`);
  }
  for (const [name, init] of sources) {
    const owner = new Response(init());
    const stream = owner.body!;
    sent = owner;
    const text = await (await fetch(sender.url)).text();
    console.log(`Response ${name} .body then Bun.serve() sends it: ${JSON.stringify(text)} ${await consumed(owner, stream, body => new Response(body))}`);
  }

  const uploaded = new Blob(["payload"]).stream();
  const text = await (await fetch(echo.url, { method: "POST", body: uploaded })).text();
  console.log(`fetch() uploading Blob.stream(): ${JSON.stringify(text)} ${state(uploaded)}`);

  // clone() of a body over an unread in-memory stream lifts the bytes out and closes it.
  for (const [ownerName, make] of [["Request", request], ["Response", (body: BodyInit) => new Response(body)]] as const) {
    for (const [name, init] of [["string", () => "payload"], ["Blob", () => new Blob(["payload"])], ["Blob.stream()", () => new Blob(["payload"]).stream()]] as const) {
      const owner = make(init());
      const stream = owner.body!;
      const clone = owner.clone();
      console.log(`${ownerName} ${name} clone():`, state(stream), `new body=${owner.body !== stream} used=${owner.bodyUsed}`, JSON.stringify([await owner.text(), await clone.text()]));
    }
    const owner = make(jsStream("payload"));
    const stream = owner.body!;
    const clone = owner.clone();
    console.log(`${ownerName} ReadableStream clone():`, state(stream), `new body=${owner.body !== stream}`, JSON.stringify([await owner.text(), await clone.text()]));
  }

  // clone() and new Request(request) of a used or locked body.
  const usedString = request("hello");
  await usedString.text();
  const usedStream = new Response(jsStream("hello"));
  await usedStream.text();
  const usedBlob = new Response(new Blob(["hello"]));
  await usedBlob.arrayBuffer();
  const lockedString = new Response("hello");
  lockedString.body!.getReader();
  const lockedStream = request(new ReadableStream({ start() {} }));
  lockedStream.body!.getReader();
  let controller!: ReadableStreamDefaultController;
  const inFlight = request(new ReadableStream({ start(c) { controller = c; } }));
  const pending = inFlight.text();
  console.log("clone() of a used string body:", message(() => usedString.clone()));
  console.log("clone() of a used stream body:", message(() => usedStream.clone()));
  console.log("clone() of a used Blob body:", message(() => usedBlob.clone()));
  console.log("clone() of a locked body:", message(() => lockedString.clone()));
  console.log("clone() of a locked stream body:", message(() => lockedStream.clone()));
  console.log("clone() during a read:", message(() => inFlight.clone()));
  controller.enqueue(new TextEncoder().encode("hello"));
  controller.close();
  console.log("the read still completes:", await pending);
  console.log("new Request(request) with a locked stream body:", message(() => new Request(lockedStream)));

  sent = new Response("hello from server");
  const fetched = await fetch(sender.url);
  await fetched.body!.getReader().read();
  console.log("clone() of a fetch() response a reader read:", message(() => fetched.clone()));

  const { promise, resolve } = Promise.withResolvers<string>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text();
      resolve(message(() => req.clone()));
      return new Response("ok");
    },
  });
  await (await fetch(server.url, { method: "POST", body: "hello" })).text();
  console.log("Bun.serve: clone() of a read incoming request:", await promise);
  server.stop(true);
} finally {
  echo.stop(true);
  sender.stop(true);
}
