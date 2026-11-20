import net from "node:net";

// Bun.serve hands a request body to the handler while it is still arriving, as Bun does,
// and fails the body with an AbortError when the client goes away mid-upload.
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

// The handler sees the first bytes before the client sends the rest.
{
  const first = Promise.withResolvers<string>();
  const done = Promise.withResolvers<string[]>();
  await using server = Bun.serve({
    port: 0,
    async fetch(req) {
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      for await (const chunk of req.body!) {
        chunks.push(decoder.decode(chunk));
        first.resolve(chunks[0]);
      }
      done.resolve(chunks);
      return new Response(`got ${chunks.join("").length} bytes`);
    },
  });
  const client = await connect(server.port!);
  client.socket.write("POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello");
  console.log("first chunk:", await first.promise);
  client.socket.write(" world");
  console.log("all chunks joined:", (await done.promise).join(""));
  await client.closed;
  const response = client.received();
  console.log("response body:", response.slice(response.indexOf("\r\n\r\n") + 4));
}

// A chunked upload streams too, and the next request on the connection follows it.
{
  const seen: string[] = [];
  await using server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      seen.push(`${req.method} ${new URL(req.url).pathname} ${JSON.stringify(text)}`);
      return new Response(`#${seen.length}`);
    },
  });
  const client = await connect(server.port!);
  client.socket.write("POST /a HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n");
  await Bun.sleep(20);
  client.socket.write("2\r\nde\r\n0\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  await client.closed;
  console.log(seen.join(" | "));
  console.log("responses:", client.received().match(/#\d/g)?.join(" "));
}

// A client that disconnects mid-upload: the handler's read fails with an AbortError.
for (const read of ["textStream", "text"] as const) {
  const firstChunk = Promise.withResolvers<void>();
  const done = Promise.withResolvers<{ name: string; received: string }>();
  await using server = Bun.serve({
    port: 0,
    async fetch(req) {
      const received: string[] = [];
      try {
        if (read === "text") {
          firstChunk.resolve();
          await req.text();
        } else {
          for await (const chunk of req.textStream()) {
            received.push(chunk);
            firstChunk.resolve();
          }
        }
        done.resolve({ name: "<no error>", received: received.join("") });
      } catch (error) {
        done.resolve({ name: (error as Error).name, received: received.join("") });
      }
      return new Response("ok");
    },
  });
  const client = await connect(server.port!);
  client.socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nhello");
  await firstChunk.promise;
  client.socket.destroy();
  console.log(read, "after disconnect:", JSON.stringify(await done.promise));
}

// fetch() to Bun.serve with a streamed body, end to end.
{
  await using server = Bun.serve({
    port: 0,
    async fetch(req) {
      return new Response(`${req.headers.get("transfer-encoding")}: ${await req.text()}`);
    },
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      for (const part of ["one ", "two ", "three"]) {
        controller.enqueue(encoder.encode(part));
        await Bun.sleep(5);
      }
      controller.close();
    },
  });
  const res = await fetch(server.url, { method: "POST", body, duplex: "half" } as RequestInit);
  console.log("fetch to Bun.serve:", await res.text());
}
