// After `wrangler deploy`: waits until https://bun.sprockt.dev serves this build's files at their
// plain URLs. A cache-busting query string doesn't prove the edge has dropped the old copy, and
// checks run right after a deploy otherwise hit stale pages.
import { join } from "node:path";
import { templates } from "../sandbox/src/template-catalog";
import { projectTemplates } from "../web/src/playground/project-templates";

const origin = "https://bun.sprockt.dev";
const dist = join(import.meta.dir, "dist");
const files = ["index.html", "main.js", "worker.js", "sw.js", "playground/index.html", "playground/main.js",
  "deployment.json", "engine-builds.json", "playground/engine-builds.json"].concat(
  templates.map(template => template.file), projectTemplates.map(template => `playground/${template.file}`));
const deadline = Date.now() + 120_000;
for (const file of files) {
  const want = await Bun.file(join(dist, file)).text();
  for (;;) {
    const got = await fetch(`${origin}/${file.replace(/index\.html$/, "")}`).then((r) => r.text(), () => "");
    if (got === want) break;
    if (Date.now() > deadline) throw new Error(`${file}: still stale after 2 minutes`);
    await Bun.sleep(2000);
  }
}
console.log(`live: ${origin} serves this build`);
