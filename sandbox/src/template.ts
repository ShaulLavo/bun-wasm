import type { Runtime } from "waffle";
import { measureStartup } from "../../web/src/startup";

type Filesystem = Runtime["filesystem"];
type TemplateSources = Record<string, string>;

export function templateFiles(text: string): TemplateSources | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("files" in value)) return null;
    const files = value.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const output: TemplateSources = {};
    for (const [path, source] of Object.entries(files)) {
      if (typeof source !== "string" || !projectPath(path)) return null;
      output[path] = source;
    }
    return typeof output["package.json"] === "string" && projectManifest(output["package.json"]) ? output : null;
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

function projectManifest(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("scripts" in value)) return false;
    const scripts = value.scripts;
    if (!scripts || typeof scripts !== "object") return false;
    return "dev" in scripts && typeof scripts.dev === "string" && scripts.dev.trim() !== ""
      && "build" in scripts && typeof scripts.build === "string" && scripts.build.trim() !== "";
  } catch { return false; }
}

function projectPath(path: string): boolean {
  return !path.includes("\0") && !path.includes("\\") && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
