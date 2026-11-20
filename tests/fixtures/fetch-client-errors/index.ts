import net from "node:net";
import { once } from "node:events";

// fetch() rejects a response head that does not parse, and a redirect it must not
// follow, with Bun's error codes. Only the redirect statuses 301, 302, 303, 307 and
// 308 count as redirects; other 3xx responses come back as they are.
async function rawServer(response: string) {
  const server = net.createServer(socket => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(response));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as net.AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/start` };
}

async function outcome(label: string, response: string, init?: RequestInit) {
  const { server, url } = await rawServer(response);
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    console.log(label, JSON.stringify({ status: res.status, redirected: res.redirected, body }));
  } catch (error) {
    const { name, code, message } = error as { name: string; code: string; message: string };
    console.log(label, JSON.stringify({ name, code, message: message.replace(url, "URL") }));
  } finally {
    server.close();
  }
}

const head = (status: string, headers: string) => `HTTP/1.1 ${status}\r\n${headers}Content-Length: 0\r\nConnection: close\r\n\r\n`;

for (const [name, char] of [["vertical tab", "\x0b"], ["SOH", "\x01"], ["DEL", "\x7f"]]) {
  await outcome(`Location with a raw ${name}:`, head("302 Found", `Location: /a${char}b\r\n`));
}
await outcome("obs-fold continuation:", "HTTP/1.1 200 OK\r\nSet-Cookie: sid=1;\r\n Secure; HttpOnly\r\nContent-Length: 2\r\n\r\nok");
await outcome("Content-Length 1_0:", "HTTP/1.1 200 OK\r\nContent-Length: 1_0\r\nConnection: close\r\n\r\n0123456789");

for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308]) {
  await outcome(`redirect "error", ${status} with Location:`, head(`${status} X`, "Location: /elsewhere\r\n"), { redirect: "error" });
}
await outcome(`redirect "error", 302 without Location:`, head("302 Found", ""), { redirect: "error" });

for (const location of ["file:/etc/hosts", "file:hosts", "data:text/plain,hi"]) {
  await outcome(`follow to ${location}:`, head("302 Found", `Location: ${location}\r\n`));
}
