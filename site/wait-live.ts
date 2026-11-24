// After `wrangler deploy`: waits until https://bun.sprockt.dev serves this build's files at their
// plain URLs. A cache-busting query string doesn't prove the edge has dropped the old copy, and
// checks run right after a deploy otherwise hit stale pages.
import { join } from "node:path";
import { templates } from "../sandbox/src/template-catalog";
import { projectTemplates } from "../web/src/playground/project-templates";

const origin = "https://bun.sprockt.dev";
const dist = join(import.meta.dir, "dist");
const hashedEntries = Array.from(new Bun.Glob("{,__bunwasm/,playground/,playground/__bunwasm/}entry-*").scanSync(dist)).sort();
const chunkFiles = Array.from(new Bun.Glob("{,__bunwasm/,playground/,playground/__bunwasm/}chunks/*.js").scanSync(dist)).sort();
const files = [
  "index.html", "main.js", "worker.js", "sw.js",
  "playground/index.html", "playground/main.js", "playground/sw.js",
  "deployment.json", "engine-builds.json", "playground/engine-builds.json",
].concat(
  hashedEntries,
  chunkFiles,
  templates.map(template => template.file),
  projectTemplates.map(template => `playground/${template.file}`),
);
const deadline = Date.now() + 120_000;
const fetchTimeoutMs = 15_000;

async function waitForFile(file: string): Promise<void> {
  const want = await Bun.file(join(dist, file)).text();
  const target = `${origin}/${file.replace(/index\.html$/, "")}`;
  for (;;) {
    const got = await fetch(target, { signal: AbortSignal.timeout(fetchTimeoutMs) })
      .then(response => response.ok ? response.text() : "", () => "");
    if (got === want) return;
    if (Date.now() > deadline) throw new Error(`${file}: still stale after 2 minutes`);
    await Bun.sleep(2000);
  }
}

// Check in bounded batches so chunks and hashed entries finish quickly without flooding the edge.
const concurrency = 12;
for (let index = 0; index < files.length; index += concurrency) {
  await Promise.all(files.slice(index, index + concurrency).map(waitForFile));
}
console.log(`live: ${origin} serves this build (${files.length} files verified)`);
