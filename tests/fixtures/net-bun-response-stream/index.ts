let controller: ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({
      start(source) {
        controller = source;
        source.enqueue(encoder.encode("first"));
      },
    }));
  },
});
try {
  const response = await fetch(server.url, { signal: AbortSignal.timeout(1000) });
  const reader = response.body!.getReader();
  console.log(new TextDecoder().decode((await reader.read()).value));
  controller!.enqueue(encoder.encode("second"));
  controller!.close();
  console.log(new TextDecoder().decode((await reader.read()).value));
  console.log((await reader.read()).done);
} finally {
  server.stop(true);
}

let cancellations = 0;
const cancelled = Promise.withResolvers<void>();
const stopping = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({
      start(source) { source.enqueue(encoder.encode("open")); },
      cancel() { cancellations++; cancelled.resolve(); },
    }));
  },
});
let cancelReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
const deadline = setTimeout(() => cancelled.reject(new Error("server stop did not cancel its response")), 1000);
try {
  cancelReader = (await fetch(stopping.url)).body!.getReader();
  await cancelReader.read();
  stopping.stop(true);
  await cancelled.promise;
  console.log("cancelled", cancellations);
} finally {
  clearTimeout(deadline);
  stopping.stop(true);
  await cancelReader?.cancel().catch(() => {});
}

const fixed = Bun.serve({
  port: 0,
  routes: { "/fixed": new Response(new Blob(["known"]).stream()) },
});
try {
  const response = await fetch(new URL("/fixed", fixed.url));
  console.log("fixed", response.headers.get("content-length"), await response.text());
} finally {
  fixed.stop(true);
}

const aborting = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({
      start(source) { source.enqueue(encoder.encode("pending")); },
    }));
  },
});
try {
  const signal = new AbortController();
  const response = await fetch(aborting.url, { signal: signal.signal });
  const body = response.text();
  signal.abort(new DOMException("deadline", "TimeoutError"));
  try {
    await body;
    throw new Error("an aborted body resolved");
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    console.log("abort", error.name);
  }
} finally {
  aborting.stop(true);
}
