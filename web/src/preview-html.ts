// Shared by the mounted preview service worker (sw-routing.ts) and the preview-origin one
// (preview-origin/sw-core.ts): both put one script first in every HTML document they serve.

/** Inserts `markup` right after the doctype, before any application script can run. */
export function insertAfterDoctype(stream: ReadableStream<Uint8Array>, markup: string): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 1024) {
        const { value, done } = await reader.read();
        if (value) { chunks.push(value); length += value.length; }
        if (done || value?.includes(62)) break;
      }
      const initial = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { initial.set(chunk, at); at += chunk.length; }
      const decoded = new TextDecoder().decode(initial);
      const doctype = /^\s*<!doctype[^>]*>/i.exec(decoded)?.[0] ?? "";
      const offset = new TextEncoder().encode(doctype).length;
      controller.enqueue(initial.subarray(0, offset));
      controller.enqueue(new TextEncoder().encode(markup));
      controller.enqueue(initial.subarray(offset));
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
