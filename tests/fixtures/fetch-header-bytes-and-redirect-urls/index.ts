import { createServer } from "node:http";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";

// Response header values are bytes: each one is a character (Latin-1), as Bun reads them.
{
  const values = [
    "inline; filename=\"image â\x80\x94 copy (1).png\"",
    "inline; filename=\"_å\x9C\x96ç\x89\x87_ð\x9F\x96¼_image_.png\"",
  ];
  const server = createServer((req, res) => {
    values.forEach((value, i) => res.setHeader(`Content-Disposition-${i + 1}`, value));
    res.end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { method: "HEAD" });
  const received = Array.from(response.headers).filter(([name]) => name.startsWith("content-disposition")).map(([, value]) => value);
  console.log("header values match:", JSON.stringify(received) === JSON.stringify(values), received.map(value => value.length));
  server.close();
}

// A fragment is never sent: a long one in each Location does not break a redirect chain.
{
  const pad = "a".repeat(96 * 1024);
  const paths: string[] = [];
  await using server = Bun.serve({
    port: 0,
    fetch(req) {
      const hop = Number(new URL(req.url).pathname.split("/")[2] ?? 0);
      paths.push(new URL(req.url).pathname);
      if (hop < 3) return new Response(null, { status: 302, headers: { Location: `${server.url.origin}/hop/${hop + 1}#${pad}` } });
      return new Response("ok");
    },
  });
  const shown = (url: string) => url.replace(server.url.origin, "ORIGIN").replace(/#(.*)$/, (_, fragment: string) => `#<${fragment.length} bytes>`);
  const res = await fetch(`${server.url.origin}/hop/0#start`);
  console.log("long fragments:", res.status, await res.text(), res.redirected, shown(res.url), paths.join(" "));
  const direct = await fetch(`${server.url.origin}/hop/3#kept`);
  console.log("no redirect:", direct.status, direct.redirected, shown(direct.url));
}

// A name that cannot resolve (a label over 63 bytes) is reported with the name that failed,
// including after a redirect.
{
  const host = "a".repeat(64) + ".com";
  const redirectHost = "c".repeat(64) + ".com";
  const report = (promise: Promise<Response>) =>
    promise.then(
      () => "resolved",
      ({ name, code, syscall, hostname, message }) => ({ name, code, syscall, hostname, message }),
    );
  console.log("direct:", JSON.stringify(await report(fetch(`http://${host}/`))));
  await using server = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://${redirectHost}/`, 302) });
  console.log("after a redirect:", JSON.stringify(await report(fetch(server.url))));
}

// A request header value is a byte string: each character up to U+00FF is one byte on the wire,
// and only tab, LF, CR and space are trimmed from its ends.
{
  const head = Promise.withResolvers<Buffer>();
  const raw = net.createServer(socket => {
    let received = Buffer.alloc(0);
    socket.on("data", chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.indexOf("\r\n\r\n") < 0) return;
      head.resolve(received);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", resolve));
  const port = (raw.address() as AddressInfo).port;
  await fetch(`http://127.0.0.1:${port}/`, {
    headers: { "X-Latin": "aé\x80ÿz", "X-Ascii": "alpha beta", "X-Inner": "a\tb  c", "X-Padded": " \t\r\ntrimmed \t", "X-Nbsp": "a b" },
  });
  const lines = (await head.promise).toString("latin1").split("\r\n");
  for (const name of ["x-latin", "x-ascii", "x-inner", "x-padded", "x-nbsp"]) {
    const line = lines.find(candidate => candidate.toLowerCase().startsWith(name + ":")) ?? "";
    const value = Buffer.from(line.slice(name.length + 1), "latin1");
    console.log("wire", name, Array.from(value, byte => byte.toString(16).padStart(2, "0")).join(" "));
  }
  raw.close();
}

// An invalid value throws a TypeError that names the header and never shows the value.
{
  const attempts: [string, () => unknown][] = [
    ["append NUL", () => new Headers().append("Authorization", "Bearer secret\0token")],
    ["append CRLF", () => new Headers().append("x-api-key", "secret\r\nX-Injected: 1")],
    ["set above U+00FF", () => new Headers().set("X-Test", "okĀ")],
    ["constructor", () => new Headers({ location: "a\nb" })],
    ["Request", () => new Request("http://example.com", { headers: { Cookie: "session=secret\ntoken" } })],
    ["fetch", () => fetch("http://127.0.0.1:1/", { headers: { "X-Test": "❤" } })],
    ["set-cookie", () => new Headers().append("set-cookie", "a\0b")],
  ];
  for (const [label, run] of attempts) {
    try {
      await run();
      console.log("invalid value", label, "did not throw");
    } catch (error) {
      console.log("invalid value", label, (error as Error).name, (error as Error).message);
    }
  }
  // Values are valid in the Latin-1 range and are trimmed only of HTTP whitespace.
  const headers = new Headers({ "X-Value": " \t\r\n é  " });
  console.log("kept", JSON.stringify(headers.get("x-value")));

  // The name is converted to a string once, and that string is the one named in the error.
  for (const method of ["append", "set"] as const) {
    const conversions: string[] = [];
    const name = {
      toString() {
        conversions.push("call");
        return conversions.length === 1 ? "X-Input" : "X-Recoerced";
      },
    };
    try {
      new Headers()[method](name as unknown as string, "bad\0value");
    } catch (error) {
      console.log(method, "name converted", conversions.length, "time:", (error as Error).message);
    }
  }
  // A quadratic scan over this much interior whitespace would never finish.
  const spaced = "x" + " ".repeat(1 << 18) + "z";
  console.log("long interior whitespace", new Headers({ "X-Probe": spaced }).get("x-probe")!.length);
}
