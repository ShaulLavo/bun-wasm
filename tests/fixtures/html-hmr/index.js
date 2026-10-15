import page from "./page.html";
const server = Bun.serve({ port: 0, routes: { "/": page } });
const html = await (await fetch(server.url)).text();
const script = /src="([^"]+\.js)"/.exec(html)?.[1];
const source = script ? await (await fetch(new URL(script, server.url))).text() : "";
console.log(source.includes("bun:hmr") ? "Bun HMR entry" : "missing Bun HMR entry");
try {
  const denied = (origin) => new Promise((resolve) => {
    const socket = new WebSocket(new URL("/_bun/hmr", server.url), { headers: { Origin: origin } });
    socket.onopen = () => { socket.close(); resolve(false); };
    socket.onerror = () => resolve(true);
  });
  if (!await denied("https://foreign.example") || !await denied("null")) throw new Error("Cross-origin HMR socket accepted");
  if (await denied(server.url.origin) || await denied("http://example.localhost:9999")) throw new Error("Local HMR origin rejected");
  console.log("Bun HMR origins");
} finally { await server.stop(true); }
