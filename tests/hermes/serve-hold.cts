// Serves until interrupted: the host fetches it, then sends SIGINT.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  fetch: (req: Request) => new Response(`hermes ${req.method} ${new URL(req.url).pathname}`),
});
console.log("listening", server.port);
process.on("SIGINT", () => {
  console.log("stopping");
  server.stop();
  process.exit(0);
});
