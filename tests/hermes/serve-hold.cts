// Serves the host until it requests /stop, then raises SIGINT on itself: the signal goes through the
// host signal ABI and comes back to this handler. (The native launcher does not forward host signals.)
const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  fetch: (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/stop") setTimeout(() => process.kill(process.pid, "SIGINT"), 0);
    return new Response(`hermes ${req.method} ${path}`);
  },
});
console.log("listening", server.port);
process.on("SIGINT", () => {
  console.log("stopping");
  server.stop();
  process.exit(0);
});
