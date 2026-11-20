// Body.textStream() releases the source stream's reader when the source closes,
// when the text stream is cancelled, and when the source yields a chunk that is
// not a BufferSource, which errors the text stream and cancels the source.
const owners: [string, (body: BodyInit) => Request | Response][] = [
  ["Request", body => new Request("http://a/", { method: "POST", body, duplex: "half" } as RequestInit)],
  ["Response", body => new Response(body)],
];

const errorName = async (promise: Promise<unknown>) => promise.then(() => "ok", (error: Error) => error.constructor.name);

for (const [owner, make] of owners) {
  const closed = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([65]));
      controller.close();
    },
  });
  const closedText = make(closed).textStream();
  const lockedBefore = closed.locked;
  const text = (await Array.fromAsync(closedText)).join("");
  console.log(`${owner} closed source: text=${text} locked before=${lockedBefore} after=${closed.locked}`);

  const endless = new ReadableStream({ pull: controller => controller.enqueue(new Uint8Array([65])) });
  const endlessText = make(endless).textStream();
  await endlessText.cancel();
  console.log(`${owner} cancelled text stream: source locked=${endless.locked}`);

  const response = make("hello");
  const body = response.body!;
  const bodyText = response.textStream();
  const locked = body.locked;
  const getReader = (() => {
    try {
      body.getReader();
      return "ok";
    } catch (error) {
      return (error as Error).constructor.name;
    }
  })();
  const cancel = await errorName(body.cancel());
  const read = (await Array.fromAsync(bodyText)).join("");
  console.log(`${owner} accessed .body: locked=${locked} getReader=${getReader} cancel=${cancel} text=${read} unlocked after=${body.locked === false}`);

  let cancelled: unknown;
  const wrong = new ReadableStream({
    start: controller => controller.enqueue("oops"),
    cancel: reason => {
      cancelled = reason;
    },
  });
  const wrongText = make(wrong).textStream();
  const failure = await errorName(Array.fromAsync(wrongText));
  console.log(`${owner} non-BufferSource chunk: error=${failure} source cancelled with=${(cancelled as Error)?.constructor.name} message=${(cancelled as Error)?.message} source locked=${wrong.locked}`);

  let controller!: ReadableStreamDefaultController;
  const pending = new ReadableStream({ start: c => void (controller = c) });
  const reader = make(pending).textStream().getReader();
  const first = reader.read();
  const second = reader.read();
  controller.enqueue(new Uint8Array([0xc2]));
  controller.close();
  const flushed = await first;
  const done = await second;
  console.log(`${owner} split character at close: value=${JSON.stringify(flushed.value)} then done=${done.done} source locked=${pending.locked}`);
}
