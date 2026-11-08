import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

process.env.NODE_ENV = "production";
const require = createRequire(join(process.cwd(), "server.cjs"));
const loaded: unknown = require("next/dist/server/next-server.js");
if (!loaded || typeof loaded !== "object" || !("default" in loaded) || typeof loaded.default !== "function") throw new Error("NextServer constructor missing");
const manifest: unknown = JSON.parse(readFileSync(".next/required-server-files.json", "utf8"));
if (!manifest || typeof manifest !== "object" || !("config" in manifest)) throw new Error("Next build config missing");
const server = Reflect.construct(loaded.default, [{ dir: process.cwd(), dev: false, conf: manifest.config, hostname: "127.0.0.1", port: 5173 }]);
await server.prepare();
createServer(server.getRequestHandler()).listen(5173, "127.0.0.1");
