let running = true;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('I/O progressed') });
function spin() {
  if (running) setImmediate(spin);
}
setImmediate(spin);
try {
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  console.log(await response.text());
} finally {
  running = false;
  server.stop(true);
}
