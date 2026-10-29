export const dynamic = "force-dynamic";
export function GET() {
  let timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("NEXT-01 early\n"));
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("NEXT-01 late\n"));
        controller.close();
      }, 500);
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
