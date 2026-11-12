import type { bodyConsumerFactory, bodyConsumerSources } from "../../scripts/body-consumer-factory.ts";

type Sources = ReturnType<typeof bodyConsumerSources>;
type Factory = typeof bodyConsumerFactory;
function streamShape(stream: ReadableStream<Uint8Array>) {
  return {
    constructor: stream.constructor.name,
    asyncIterator: typeof Reflect.get(stream, Symbol.asyncIterator),
    values: typeof Reflect.get(stream, "values"),
    getReader: typeof stream.getReader,
    locked: stream.locked,
  };
}
function freshStream() {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"value":"probe"}')); controller.close(); } });
}
async function outcome(label: string, read: () => Promise<unknown>) {
  try { return { label, status: "fulfilled", value: String(await read()) }; }
  catch (error) { return { label, status: "rejected", error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
}
export async function bodyConsumerCapability(sources: Sources, factory: Factory, mode = "native") {
  const { web, consumers } = factory(sources);
  const response = new web.Response(freshStream());
  const request = new web.Request("http://localhost/", { method: "POST", body: freshStream(), duplex: "half" });
  const rows: object[] = [{ mode, stream: streamShape(freshStream()), response: streamShape(response.body!), request: streamShape(request.body!), nativeResponse: streamShape(new Response("native").body!) }];
  rows.push(await outcome("reader", async () => {
    const stream = freshStream();
    const reader = stream.getReader();
    try { return new TextDecoder().decode((await reader.read()).value); }
    finally { reader.releaseLock(); }
  }));
  rows.push(await outcome("Response.json", () => response.json()));
  rows.push(await outcome("Request.text", () => request.text()));
  rows.push(await outcome("consumers.text", () => consumers.text(freshStream())));
  rows.push(await outcome("consumers.blob", async () => (await consumers.blob(freshStream())).text()));
  return rows;
}
