import { once } from "node:events";
import { createServer, connect } from "node:net";

const server = createServer();
const accepted = once(server, "connection");
await once(server.listen(0, "127.0.0.1"), "listening");
const client = connect({ host: "127.0.0.1", port: server.address().port });
const [peer] = await accepted;
const ended = once(peer, "end");
const closed = once(peer, "close");
const deadline = Promise.withResolvers<never>();
const timer = setTimeout(() => deadline.reject(new Error("accepted empty FIN did not close")), 1000);
try {
  client.end();
  await Promise.race([ended, deadline.promise]);
  console.log("end", peer.readableLength);
  await Promise.race([closed, deadline.promise]);
  console.log("close", peer.writableFinished);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  console.log("server closed");
} finally {
  clearTimeout(timer);
  client.destroy();
  peer.destroy();
  server.close();
}
