const server = Bun.serve({
  port: 0,
  fetch: (req: Request) => new Response(`hello from ${new URL(req.url).pathname}`),
});
fetch(`http://127.0.0.1:${server.port}/hermes`)
  .then(res => res.text().then(body => console.log(res.status, body)))
  .finally(() => server.stop());
