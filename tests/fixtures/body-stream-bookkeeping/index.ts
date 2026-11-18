import { isDisturbed, isErrored, isReadable } from "node:stream";
import { readFileSync } from "node:fs";

// Consuming a Request or Response body reads its stream through a reader that is
// never released, whatever backs the body, and a used or locked stream cannot
// become another body.
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
];
const owners: [string, (body: BodyInit) => Request | Response][] = [
  ["Request", body => new Request("http://a/", { method: "POST", body, duplex: "half" } as RequestInit)],
  ["Response", body => new Response(body)],
];
const errorName = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
};
const settled = (promise: Promise<unknown>) => promise.then(() => "ok", error => (error as Error).constructor.name);
const state = (stream: ReadableStream) => `readable=${isReadable(stream as never)} errored=${isErrored(stream as never)} disturbed=${isDisturbed(stream as never)} locked=${stream.locked}`;

for (const [ownerName, make] of owners) {
  for (const [name, init] of sources) {
    for (const method of ["text", "arrayBuffer", "bytes", "blob"] as const) {
      const owner = make(init());
      const stream = owner.body!;
      await owner[method]();
      console.log(`${ownerName} ${name} .body then ${method}():`, state(stream), `same=${owner.body === stream} used=${owner.bodyUsed} getReader=${errorName(() => stream.getReader())} rewrap=${errorName(() => make(stream))} again=${await settled(owner[method]())} clone=${errorName(() => owner.clone())}`);
    }
    const owner = make(init());
    await owner.text();
    const stream = owner.body!;
    console.log(`${ownerName} ${name} text() then .body:`, state(stream), `used=${owner.bodyUsed} getReader=${errorName(() => stream.getReader())}`);
  }

  const failing = new ReadableStream({ pull: controller => controller.error(new Error("boom")) });
  const errored = make(failing);
  console.log(`${ownerName} erroring stream:`, await settled(errored.text()), `locked=${failing.locked} used=${errored.bodyUsed} getReader=${errorName(() => failing.getReader())}`);

  const held = jsStream("x");
  const holder = make(held);
  const reader = held.getReader();
  const lockedRead = await holder.text().then(() => "ok", error => `${(error as Error).constructor.name} ${(error as { code?: string }).code} ${(error as Error).message}`);
  console.log(`${ownerName} locked by a reader:`, lockedRead, `used=${holder.bodyUsed}`);
  reader.releaseLock();
  console.log(`${ownerName} after releasing it:`, await holder.text(), `used=${holder.bodyUsed}`);

  const from = make("payload");
  const adopted = from.body!;
  const to = make(adopted);
  console.log(`${ownerName} adopts an unread stream:`, `same=${to.body === adopted} locked=${adopted.locked} fromUsed=${from.bodyUsed} toUsed=${to.bodyUsed}`, await to.text(), `locked=${adopted.locked} fromUsed=${from.bodyUsed} again=${await settled(from.text())}`);

  const piped = make("");
  const pipedOut = piped.body!.pipeThrough(new TransformStream());
  console.log(`${ownerName} piping an empty .body:`, await settled(piped.text()), `used=${piped.bodyUsed}`, JSON.stringify(await new Response(pipedOut).text()));

  const written = make("written");
  const target = `bookkeeping-${ownerName}.txt`;
  await Bun.write(target, written);
  console.log(`${ownerName} Bun.write():`, readFileSync(target, "utf8"), `used=${written.bodyUsed}`);
}

// Fetch forbids keepalive with a stream body; Bun checks it before the stream's lock.
const lockedStream = new ReadableStream();
lockedStream.getReader();
for (const [label, body] of [["stream", new ReadableStream()], ["locked stream", lockedStream], ["string", "x"]] as const) {
  console.log("keepalive", label, errorName(() => new Request("http://a/", { method: "PUT", body, keepalive: true, duplex: "half" } as RequestInit)));
}
