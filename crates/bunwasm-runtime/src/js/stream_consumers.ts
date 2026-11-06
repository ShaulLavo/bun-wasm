(function (internal: BunWasm.Internal) {
  "use strict";
  const { Buffer } = internal.require("buffer");
  const JSONParse = JSON.parse;
  const bodyStreams = internal.require("body_streams");
  type Input<T> = AsyncIterable<T> | Iterable<T> | ReadableStream<T>;
  type Parts = Input<BlobPart>;
  type TextParts = Input<string | AllowSharedBufferSource>;
  async function consume<T>(stream: Input<T>, visit: (chunk: T) => void): Promise<void> {
    if (stream instanceof ReadableStream) return bodyStreams.consume(stream, visit);
    for await (const chunk of stream) visit(chunk);
  }

  async function blob(stream: Parts): Promise<Blob> {
    const chunks: BlobPart[] = [];
    await consume(stream, chunk => chunks.push(chunk));
    return new Blob(chunks);
  }

  async function arrayBuffer(stream: Parts): Promise<ArrayBuffer> {
    const result = await blob(stream);
    return result.arrayBuffer();
  }

  async function bytes(stream: Parts): Promise<Uint8Array> {
    return new Uint8Array(await arrayBuffer(stream));
  }

  async function buffer(stream: Parts): Promise<BunWasm.BufferBytes> {
    return Buffer.from(await arrayBuffer(stream));
  }

  async function text(stream: TextParts): Promise<string> {
    const decoder = new TextDecoder();
    let result = "";
    await consume(stream, chunk => {
      result += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    });
    return result + decoder.decode();
  }

  async function json(stream: TextParts): Promise<unknown> {
    return JSONParse(await text(stream));
  }

  return { arrayBuffer, bytes, text, json, buffer, blob };
})
