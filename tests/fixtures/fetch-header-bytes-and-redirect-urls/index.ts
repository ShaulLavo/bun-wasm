import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

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
