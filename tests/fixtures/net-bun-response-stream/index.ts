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
