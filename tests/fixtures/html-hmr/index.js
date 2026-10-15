import page from "./page.html";
const server = Bun.serve({ port: 0, routes: { "/": page } });
const html = await (await fetch(server.url)).text();
const script = /src="([^"]+\.js)"/.exec(html)?.[1];
const source = script ? await (await fetch(new URL(script, server.url))).text() : "";
console.log(source.includes("bun:hmr") ? "Bun HMR entry" : "missing Bun HMR entry");
await server.stop(true);
