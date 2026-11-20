import net from "node:net";
import { once } from "node:events";

// Bun.inspect and console.log show a Request or Response the way Bun does: its size, its
// fields, its headers and what backs its body.
const show = (label: string, value: unknown) => console.log(`${label}: ${Bun.inspect(value)}`);
show("string", new Response("hello"));
show("null body", new Response(null, { status: 204, statusText: "Nothing" }));
show("blob", new Response(new Blob(["abc"], { type: "text/x" }), { headers: { "x-a": "1", "x-quote": 'say "hi"' } }));
show("bytes", new Response(new Uint8Array(2048)));
const used = new Response("x");
await used.text();
show("used", used);
show("error", Response.error());
show("request", new Request("http://localhost/x", { method: "POST", body: "hey", headers: { accept: "*/*" } }));
show("request without body", new Request("http://localhost/y"));
console.log("nested:", Bun.inspect({ response: new Response("hi") }));
// A body built from a stream, even one over a Blob's or another body's bytes, has no known size.
const firstLine = (value: unknown) => Bun.inspect(value).split("\n")[0];
console.log("from blob.stream():", firstLine(new Response(new Blob(["abc"], { type: "text/x" }).stream())), Bun.inspect(new Response(new Blob(["abc"]).stream())).includes("ReadableStream"));
console.log("request from blob.stream():", firstLine(new Request("http://a/", { method: "POST", body: new Blob(["abc"]).stream() })));
console.log("from another body:", firstLine(new Response(new Response("xy").body)));
console.log(String(new Response()), `${new Request("http://a/")}`);

// A fetched Response reports the Content-Length as its size until the body has arrived.
const server = net.createServer(socket => {
  socket.on("error", () => {});
  socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nX-Server: raw\r\n\r\n0123456789"));
});
await once(server.listen(0, "127.0.0.1"), "listening");
const { port } = server.address() as net.AddressInfo;
const fetched = await fetch(`http://127.0.0.1:${port}/path`);
console.log("fetched:", Bun.inspect(fetched).replace(String(port), "PORT"));
console.log("text:", await fetched.text());
server.close();
