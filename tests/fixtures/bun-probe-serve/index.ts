// Bun.serve as a Bun author tries it first: routes, WebSocket upgrade with pub/sub, streaming
// responses (docs/bun-api-probe.md). Each check prints one line.
async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

type Data = { user: string };
const server = Bun.serve<Data, Record<string, never>>({
  port: 0,
  routes: {
    "/": new Response("home"),
    "/api/users/:id": req => Response.json({ id: req.params.id }),
    "/api/posts": {
      GET: () => Response.json([{ id: 1 }]),
      POST: async req => Response.json({ created: await req.json() }, { status: 201 }),
    },
    "/static.txt": new Response(Bun.file("static.txt")),
    "/redirect": Response.redirect("/", 302),
    "/wild/*": req => new Response(`wild ${new URL(req.url).pathname}`),
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { user: url.searchParams.get("user") ?? "anon" } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/stream") {
      const stream = new ReadableStream({
        async start(controller) {
          for (const part of ["one ", "two ", "three"]) {
            controller.enqueue(new TextEncoder().encode(part));
            await Bun.sleep(1);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/generator") {
      return new Response(async function* () {
        yield "gen-a ";
        await Bun.sleep(1);
        yield "gen-b";
      });
    }
    if (url.pathname === "/direct") {
      return new Response(new ReadableStream({
        type: "direct",
        pull(controller) {
          controller.write("direct-a ");
          controller.write("direct-b");
          controller.close();
        },
      } as unknown as UnderlyingDefaultSource));
    }
    if (url.pathname === "/throws") throw new Error("boom");
    return new Response("not found", { status: 404 });
  },
  error(error) {
    return new Response(`handled: ${error.message}`, { status: 500 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("room");
      ws.send(`welcome ${ws.data.user}`);
    },
    message(ws, message) {
      if (message === "broadcast") server.publish("room", `broadcast from ${ws.data.user}`);
      else ws.send(`echo ${message}`);
    },
    close(ws, code) {
      closes.push(`${ws.data.user}:${code}`);
    },
  },
});
const closes: string[] = [];
await Bun.write("static.txt", "static file body");
const base = server.url.href.replace(/\/$/, "");
const text = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return `${res.status} ${await res.text()}`;
};

await check("server.url", () => [server.url.protocol, server.port > 0, typeof server.hostname]);
await check("static route", () => text("/"));
await check("param route", () => text("/api/users/42"));
await check("method route GET", () => text("/api/posts"));
await check("method route POST", () => text("/api/posts", { method: "POST", body: JSON.stringify({ title: "hi" }), headers: { "content-type": "application/json" } }));
await check("file route", () => text("/static.txt"));
await check("redirect route", async () => {
  const res = await fetch(base + "/redirect", { redirect: "manual" });
  return [res.status, res.headers.get("location")];
});
await check("wildcard route", () => text("/wild/a/b"));
await check("fallback 404", () => text("/missing"));
await check("error handler", () => text("/throws"));
await check("ReadableStream response", () => text("/stream"));
await check("async generator response", () => text("/generator"));
await check("direct stream response", () => text("/direct"));
await check("streamed body reader", async () => {
  const res = await fetch(base + "/stream");
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) chunks.push(decoder.decode(chunk));
  return chunks.join("");
});

function openSocket(user: string): Promise<{ ws: WebSocket; messages: string[]; next: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?user=${user}`);
    const messages: string[] = [];
    const waiters: ((value: string) => void)[] = [];
    ws.onmessage = event => {
      const waiter = waiters.shift();
      if (waiter) waiter(String(event.data));
      else messages.push(String(event.data));
    };
    ws.onerror = () => reject(new Error("websocket error"));
    ws.onopen = () => resolve({
      ws,
      messages,
      next: () => messages.length ? Promise.resolve(messages.shift()!) : new Promise(r => waiters.push(r)),
    });
  });
}
await check("websocket upgrade + echo", async () => {
  const client = await openSocket("ada");
  const welcome = await client.next();
  client.ws.send("ping");
  const echo = await client.next();
  client.ws.close(1000);
  return [welcome, echo];
});
await check("websocket pub/sub", async () => {
  const a = await openSocket("a");
  const b = await openSocket("b");
  await a.next();
  await b.next();
  a.ws.send("broadcast");
  const got = await Promise.all([a.next(), b.next()]);
  a.ws.close();
  b.ws.close();
  return got;
});
await check("server.stop", async () => {
  await Bun.sleep(20);
  await server.stop(true);
  return closes.sort();
});
