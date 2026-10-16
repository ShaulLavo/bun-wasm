export async function decodedResponse(upstream: Response) {
  const bytes = await upstream.arrayBuffer();
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(bytes, { status: upstream.status, headers });
}
