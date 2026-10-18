import { once } from "node:events";
import { createServer, request } from "node:http";

const server = createServer((incoming, response) => {
  console.log("handler", incoming.complete);
  incoming.on("data", chunk => {
    console.log("chunk", chunk.toString(), incoming.complete);
    response.end("received");
  });
});
try {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const result = Promise.withResolvers<string>();
  const outgoing = request({
    hostname: "127.0.0.1",
    port: server.address().port,
    method: "POST",
    signal: AbortSignal.timeout(1000),
  }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => result.resolve(body));
  });
  outgoing.on("error", result.reject);
  outgoing.write("first");
  console.log(await result.promise);
  outgoing.end();
} finally {
  server.closeAllConnections();
  server.close();
}
