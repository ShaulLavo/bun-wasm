import net from "node:net";

// Bun.serve's maxRequestBodySize, as Bun applies it: a Content-Length over the cap gets a 413
// before any handler runs; a chunked body that grows past it fails the handler's reads, on the
// request and on its clone, and the client gets a 413 and a closed connection.
async function connect(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  socket.setEncoding("latin1");
  socket.on("error", () => {});
  let raw = "";
  socket.on("data", chunk => (raw += chunk));
  await new Promise<void>(resolve => socket.once("connect", () => resolve()));
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  return { socket, received: () => raw, closed };
}
const statusLine = (raw: string) => raw.split("\r\n")[0];
const chunk = (text: string) => `${text.length.toString(16)}\r\n${text}\r\n`;

{
  let handled = 0;
  const reads: string[] = [];
  await using server = Bun.serve({
    port: 0,
    maxRequestBodySize: 10,
    async fetch(req) {
      handled++;
      reads.push(await req.text().then(text => `text ${text.length}`, error => `rejected ${error.name}: ${error.message}`));
      return new Response("handled");
    },
  });
  const send = async (request: string) => {
    const client = await connect(server.port!);
    client.socket.write(request);
    await client.closed;
    return statusLine(client.received());
  };
  console.log("declared over the cap:", await send("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 11\r\n\r\nhello world"), "handlers run:", handled);
  console.log("at the cap:", await send("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhelloworld"), reads.at(-1));
  console.log("chunked over the cap, sent whole:", await send(`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${chunk("hello world")}0\r\n\r\n`), reads.at(-1));
  console.log("chunked under the cap:", await send(`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk("hello")}${chunk("abc")}0\r\n\r\n`), reads.at(-1));
  const response = await fetch(server.url, { method: "POST", body: "x".repeat(11) });
  console.log("fetch over the cap:", response.status, JSON.stringify(await response.text()), "handlers run:", handled);
}

// A chunked body streamed past the cap: a reader on the request or on its clone gets the bytes
// that fit, then Bun's error.
for (const side of ["original", "clone"] as const) {
  const firstPart = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  await using server = Bun.serve({
    port: 0,
    maxRequestBodySize: 8,
    async fetch(req) {
      const clone = req.clone();
      const reader = (side === "original" ? req : clone).body!.getReader();
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          firstPart.resolve();
        }
        result.resolve(`done after ${received} bytes`);
      } catch (error) {
        result.resolve(`rejected after ${received} bytes: ${(error as Error).name}: ${(error as Error).message}`);
      }
      return new Response("handled");
    },
  });
  const client = await connect(server.port!);
  client.socket.write(`POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${chunk("abcdef")}`);
  await firstPart.promise;
  client.socket.write(chunk("ghijkl"));
  console.log(`streamed past the cap, reading the ${side}:`, await result.promise);
  await client.closed;
  console.log(`  client got:`, statusLine(client.received()));
}

// The default cap is Bun's 128 MiB; an option that is not a positive number keeps it.
for (const value of [undefined, 0, "5", -1]) {
  await using server = Bun.serve({ port: 0, maxRequestBodySize: value as number, fetch: async req => new Response(`${(await req.text()).length}`) });
  const response = await fetch(server.url, { method: "POST", body: "x".repeat(64) });
  console.log("maxRequestBodySize", JSON.stringify(value) ?? "undefined", "->", response.status, await response.text());
}
