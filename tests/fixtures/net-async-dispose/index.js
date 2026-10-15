import http from "node:http";
import net from "node:net";
import { once } from "node:events";

const server = http.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let endResponse;
const received = new Promise(resolve => server.on("request", (_, res) => { endResponse = () => res.end("complete"); resolve(); }));
const response = fetch(`http://127.0.0.1:${server.address().port}/`);
await received;
let disposed = false;
const closing = server[Symbol.asyncDispose]().then(() => { disposed = true; });
await Bun.sleep(10);
console.log("http pending", !disposed, !server.listening);
endResponse();
console.log("http response", await (await response).text());
await closing;
console.log("http closed", disposed);
try { await server[Symbol.asyncDispose](); } catch (error) { console.log("http repeat", error.code); }

const tcp = net.createServer();
await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
const accepted = once(tcp, "connection");
const client = net.connect(tcp.address().port, "127.0.0.1");
const [socket] = await accepted;
const clientClosed = once(client, "close");
let drained = false;
const closingTcp = tcp[Symbol.asyncDispose]().then(() => { drained = true; });
await Bun.sleep(10);
console.log("tcp pending", !drained, !tcp.listening);
socket.end("drained");
client.resume();
await clientClosed;
await closingTcp;
await tcp[Symbol.asyncDispose]();
console.log("tcp closed", drained);

for (const api of [http, net]) {
  const failing = api.createServer();
  await new Promise(resolve => failing.listen(0, "127.0.0.1", resolve));
  const close = failing.close;
  failing.close = callback => callback(new Error("close failed"));
  try { await failing[Symbol.asyncDispose](); } catch (error) { console.log("propagates", error.message); }
  await new Promise(resolve => close.call(failing, resolve));
}
