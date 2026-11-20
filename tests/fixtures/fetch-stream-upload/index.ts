import net from "node:net";
import { once } from "node:events";

// fetch() streams a ReadableStream request body as it is produced, as Bun does: chunked,
// one chunk per non-empty read, or raw under the caller's Content-Length. A body whose
// bytes are already in memory goes out whole with a Content-Length.
const encoder = new TextEncoder();

// A raw server that records the request and answers once `complete` says it has it all.
async function recorder(complete: (raw: string) => boolean, response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok") {
  let raw = "";
  const seen = new Set<(raw: string) => void>();
  const server = net.createServer(socket => {
    socket.setEncoding("latin1");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      raw += chunk;
      for (const listener of seen) listener(raw);
      if (complete(raw)) socket.end(response);
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as net.AddressInfo;
  const wire = () => {
    const end = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, end).toLowerCase();
    const framing = head.includes("transfer-encoding: chunked") ? "chunked" : (head.match(/content-length: \d+/)?.[0] ?? "none");
    return { framing, body: raw.slice(end + 4) };
  };
  const until = (predicate: (raw: string) => boolean) =>
    new Promise<void>(resolve => {
      const listener = (now: string) => {
        if (!predicate(now)) return;
        seen.delete(listener);
        resolve();
      };
      seen.add(listener);
      listener(raw);
    });
  return { url: `http://127.0.0.1:${port}/`, wire, until, close: () => server.close() };
}

const stream = (chunks: string[]) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

for (const chunks of [["AAAA", "", "BBBB"], ["", "AAAA"]]) {
  const server = await recorder(raw => raw.endsWith("0\r\n\r\n"));
  const res = await fetch(server.url, { method: "POST", body: stream(chunks), duplex: "half" } as RequestInit);
  console.log("chunks", JSON.stringify(chunks), await res.text(), JSON.stringify(server.wire()));
  server.close();
}

{
  const server = await recorder(raw => raw.endsWith("AAAABBBB"));
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-length": "8" },
    body: stream(["AAAA", "", "BBBB"]),
    duplex: "half",
  } as RequestInit);
  console.log("with Content-Length:", await res.text(), JSON.stringify(server.wire()));
  server.close();
}

// The second chunk is produced only after the server has received the first one, so
// this finishes only if the body is sent while the stream is still open.
{
  const server = await recorder(raw => raw.endsWith("0\r\n\r\n"));
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("first"));
      await server.until(raw => raw.includes("first"));
      controller.enqueue(encoder.encode("second"));
      controller.close();
    },
  });
  const res = await fetch(server.url, { method: "PUT", body, duplex: "half" } as RequestInit);
  console.log("sent while open:", await res.text(), JSON.stringify(server.wire()));
  server.close();
}

// Bytes in memory behind a stream keep their Content-Length.
for (const [label, make] of [
  ["Response body", () => new Response("x").body!],
  ["Blob stream", () => new Blob(["abcd"]).stream()],
  ["Request around a stream", () => new Request("http://localhost/", { method: "POST", body: new Response("xy").body, duplex: "half" } as RequestInit).body!],
] as const) {
  const server = await recorder(raw => raw.includes("\r\n\r\n"));
  const res = await fetch(server.url, { method: "POST", body: make(), duplex: "half" } as RequestInit);
  await res.text();
  console.log(label, JSON.stringify(server.wire().framing));
  server.close();
}

// Every method but GET and HEAD sends a Content-Length, even for an empty or absent body.
for (const [label, init] of [
  ["POST without a body", { method: "POST" }],
  ["POST with an empty string", { method: "POST", body: "" }],
  ["PUT with empty bytes", { method: "PUT", body: new Uint8Array(0) }],
  ["DELETE without a body", { method: "DELETE" }],
  ["GET", {}],
] as const) {
  const server = await recorder(raw => raw.includes("\r\n\r\n"));
  await (await fetch(server.url, init as RequestInit)).text();
  console.log(label, JSON.stringify(server.wire().framing));
  server.close();
}

// A stream cannot be sent twice: only a 303 redirect, which drops the body, is followed.
for (const status of [303, 307, 308, 302]) {
  let requests = 0;
  await using final = Bun.serve({ port: 0, fetch: req => new Response(`${req.method} ${new URL(req.url).pathname}`) });
  const server = net.createServer(socket => {
    socket.on("error", () => {});
    socket.once("data", () => {
      requests++;
      socket.end(`HTTP/1.1 ${status} X\r\nLocation: ${final.url.origin}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as net.AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/start`, { method: "POST", body: stream(["data"]), duplex: "half" } as RequestInit);
    console.log(status, "followed:", res.status, await res.text(), requests);
  } catch (error) {
    const { name, code, message } = error as { name: string; code: string; message: string };
    console.log(status, "rejected:", name, code, JSON.stringify(message.replaceAll(String(port), "PORT")), requests);
  } finally {
    server.close();
  }
}

// A body stream that fails rejects the fetch with its error.
{
  const server = await recorder(() => false);
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("part"));
      await server.until(raw => raw.includes("part"));
      controller.error(new Error("source broke"));
    },
  });
  const outcome = await fetch(server.url, { method: "POST", body, duplex: "half" } as RequestInit).then(
    () => "resolved",
    error => `rejected: ${(error as Error).message}`,
  );
  console.log("failing body:", outcome);
  server.close();
}
