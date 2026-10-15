export {};
const server = Bun.serve({ port: 0, routes: { "/a/:id": request => new Response(request.params.id) } });
try {
  for (const path of ["/a/x", "//a/x", "///a/x", "////a/x", "//a//x", "//a/x/"]) {
    const response = await fetch(server.url.origin + path);
    console.log(path, response.status, response.status === 200 ? await response.text() : "missing");
  }
} finally {
  await server.stop(true);
}
