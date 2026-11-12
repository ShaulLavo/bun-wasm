import { Hono } from "hono";
import page from "./src/page.html" with { type: "text" };
const client = await Bun.build({ entrypoints: ["counter.ts"], target: "browser" });
if (!client.success || !client.outputs[0]) throw new Error("Counter build failed");
const app = new Hono();
app.get("/counter.ts", () => new Response(client.outputs[0], { headers: { "content-type": "text/javascript" } }));
app.get("/", c => c.html(page));
Bun.serve({ hostname: "127.0.0.1", port: 5173, fetch: app.fetch });
