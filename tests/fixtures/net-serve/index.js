// Bun.serve inside the guest, exercised with the guest's own fetch.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/static": new Response("static route"),
    "/users/:id": (req) => Response.json({ id: req.params.id }),
    "/method": { GET: () => new Response("got"), POST: async (req) => new Response(`posted ${await req.text()}`) },
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/throw") throw new Error("handler failed");
    if (url.pathname === "/ip") return new Response(srv.requestIP(req).address);
    if (url.pathname === "/async") {
      await Bun.sleep(5);
      return new Response("async ok", { status: 201, headers: { "x-from": "guest" } });
    }
    return new Response(`${req.method} ${url.pathname}${url.search} ${await req.text()}`);
  },
  error(err) {
    return new Response(`error page: ${err.message}`, { status: 500 });
  },
});
console.log("listening:", typeof server.port, server.port > 0, server.url.hostname, server.url.protocol);
const base = `http://127.0.0.1:${server.port}`;
const get = async (path, init) => {
  const res = await fetch(base + path, init);
  return `${res.status} ${res.headers.get("x-from") ?? "-"} ${await res.text()}`;
};
console.log(await get("/hello?x=1"));
console.log(await get("/echo", { method: "POST", body: "payload" }));
console.log(await get("/static"));
console.log(await get("/users/42"));
console.log(await get("/method"));
console.log(await get("/method", { method: "POST", body: "data" }));
console.log(await get("/async"));
console.log(await get("/throw"));
console.log(await get("/ip"));
const many = await Promise.all(Array.from({ length: 5 }, (_, i) => get(`/n${i}`)));
console.log(many.join(" | "));
await server.stop();
try {
  await fetch(base + "/after-stop");
  console.log("still serving");
} catch {
  console.log("stopped");
}
