import type { Runtime } from "waffle";
import { decode } from "../../web/src/fs";
import { measureStartup } from "../../web/src/startup";

type Filesystem = Runtime["filesystem"];
export type TemplateSources = Record<string, string>;

function templateFiles(text: string): TemplateSources | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("files" in value)) return null;
    const files = value.files;
    if (!files || typeof files !== "object") return null;
    const output: TemplateSources = {};
    for (const [path, source] of Object.entries(files)) {
      if (typeof source !== "string") return null;
      output[path] = source;
    }
    return typeof output["index.html"] === "string" ? output : null;
  } catch { return null; }
}

/** Fetches the template and seeds `app` with it on first use or reset. */
export async function loadTemplate(fs: Filesystem, app: string, templateFile: string, reset = false): Promise<TemplateSources> {
  const started = performance.now();
  const response = await fetch(`./${templateFile}`);
  if (!response.ok) throw new Error(`${templateFile}: HTTP ${response.status}`);
  const files = templateFiles(await response.text());
  if (!files) throw new Error(`${templateFile}: invalid project files`);
  measureStartup("template", started);
  const initialized = `${app}/.bunwasm-initialized`;
  // A directory alone may be a persisted prefix of startup or reset. Only mark a complete
  // seed, so reload retries an interrupted replacement instead of accepting partial files.
  // Once marked, intentionally deleted template files stay deleted until an explicit reset.
  if (reset || !await fs.lookup(initialized)) {
    // Reset is destructive once replacement starts. If interrupted, its absent marker
    // makes the next startup finish a clean reset rather than mixing old and new files.
    await fs.remove(app);
    await fs.mkdirp(app);
    for (const [path, text] of Object.entries(files)) await fs.writeFile(`${app}/${path}`, text);
    await fs.mkdirp(initialized);
    await fs.flush();
  }
  return files;
}

function isDependency(path: string): boolean {
  return path === "package.json" || path.startsWith("node_modules/");
}

/** A persisted or program-written dependency edit must also invalidate the bundle cache. */
export async function dependenciesChanged(fs: Filesystem, app: string, sources: TemplateSources): Promise<boolean> {
  const paths = (await fs.listFiles(app)).map((path) => path.slice(app.length + 1)).filter(isDependency);
  if (paths.length !== Object.keys(sources).filter(isDependency).length) return true;
  for (const path of paths) {
    const data = await fs.readFile(`${app}/${path}`);
    if (!data || decode(data) !== sources[path]) return true;
  }
  return false;
}
