import { once } from "node:events";
import { createConnection } from "node:net";

/** Dials an abstract name, half-closes and returns the echoed reply. */
export async function echo(name: string, message: string): Promise<string> {
  const socket = createConnection(name);
  let received = "";
  socket.on("data", bytes => { received += bytes.toString(); });
  const closed = once(socket, "close");
  socket.end(message);
  await closed;
  return received;
}
