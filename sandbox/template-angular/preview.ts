import { resolve, sep } from "node:path";
const root = resolve("dist/app/browser");
Bun.serve({
  hostname: "127.0.0.1",
  port: 5173,
  async fetch(request) {
    const name = new URL(request.url).pathname;
    const path = resolve(root, "." + (name === "/" ? "/index.html" : name));
    if (!path.startsWith(root + sep)) return new Response(null, { status: 404 });
    const file = Bun.file(path);
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  },
});
