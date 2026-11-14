import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { staged, evidence } from "./paths.ts";
const files = [];
const bodies: Record<string, string> = {};
for (const path of (await readdir(staged, { recursive: true })).sort()) {
  if (!path.endsWith(".js") && !path.endsWith(".html")) continue;
  const body = await Bun.file(join(staged, path)).text();
  const sha256 = Bun.SHA256.hash(body, "hex");
  bodies[sha256] = body;
  files.push({ path, sha256, bytes: Buffer.byteLength(body) });
}
assert(files.some(file => file.path === "sandbox/__bunwasm/worker.js"));
await Bun.write(join(evidence, "OUTPUT-INVENTORY.json"), JSON.stringify(files, null, 2));
await Bun.write(join(evidence, "OUTPUT-BODIES.json.gz"), Bun.gzipSync(JSON.stringify(bodies)));
