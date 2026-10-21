async function prelude(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (!done) {
    const next = await reader.read();
    if (next.value) { chunks.push(next.value); length += next.value.length; }
    done = next.done || Boolean(next.value?.includes(62));
    if (length > 65536 && !done) throw new Error("Preview HTML prelude exceeds policy limit");
  }
  const initial = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { initial.set(chunk, at); at += chunk.length; }
  if (initial[0] === 255 || initial[0] === 254) throw new Error("Non-UTF-8 HTML is unsupported");
  const doctype = /^\s*<!doctype[^>]*>/i.exec(new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(initial, { stream: true }))?.[0] ?? "";
  return { initial, offset: new TextEncoder().encode(doctype).length };
}
export function prependPreviewScript(body: ReadableStream<Uint8Array>, scriptURL: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const script = new TextEncoder().encode(`<script src="${scriptURL}"></script>`);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const { initial, offset } = await prelude(reader);
        controller.enqueue(initial.subarray(0, offset));
        controller.enqueue(script);
        controller.enqueue(initial.subarray(offset));
      } catch (error) { await reader.cancel(error); controller.error(error); }
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) { reader.releaseLock(); controller.close(); return; }
      controller.enqueue(value);
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
  });
}
