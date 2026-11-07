export function fixtureGuestResponse(pathname: string, guest: Blob | Uint8Array<ArrayBuffer>, headers: Readonly<Record<string, string>>): Response | undefined {
  if (pathname === "/bun-guest.wasm") return new Response(guest, { headers: { ...headers, "Content-Type": "application/wasm" } });
  if (pathname !== "/bun-guest.wasm.gz") return;
  const body = guest instanceof Blob ? guest.stream() : new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { controller.enqueue(guest); controller.close(); },
  });
  return new Response(body.pipeThrough(new CompressionStream("gzip")), { headers: { ...headers, "Content-Type": "application/gzip" } });
}
