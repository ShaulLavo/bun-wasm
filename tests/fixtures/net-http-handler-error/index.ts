import { once } from "node:events";
import { createServer } from "node:http";

const server = createServer(() => { throw new Error("handler failure"); });
try {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(1000) });
  console.log(response.status);
  await response.text();
} finally {
  server.closeAllConnections();
  server.close();
}
