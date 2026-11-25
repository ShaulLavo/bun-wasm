import type { Runtime } from "waffle";
import { measureStartup } from "../../web/src/startup";
import { assetBuild } from "../../web/src/startup-cache";

type Filesystem = Runtime["filesystem"];
export type TemplateSources = Record<string, string>;

export function templateFiles(text: string): TemplateSources | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("files" in value)) return null;
    const files = value.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const output: TemplateSources = Object.create(null);
    for (const [path, source] of Object.entries(files)) {
      if (typeof source !== "string" || !projectPath(path)) return null;
      output[path] = source;
    }
    return typeof output["package.json"] === "string" && projectManifest(output["package.json"]) ? output : null;
  } catch { return null; }
}

export function templateUrl(templateFile: string): string {
  const build = assetBuild(templateFile);
  return build ? `./${templateFile}?v=${encodeURIComponent(build)}` : `./${templateFile}`;
}

export async function fetchTemplateSources(
  templateFile: string,
  options: { signal?: AbortSignal } = {},
): Promise<TemplateSources> {
  const started = performance.now();
  const response = await fetch(templateUrl(templateFile), { signal: options.signal });
  if (!response.ok) throw new Error(`${templateFile}: HTTP ${response.status}`);
  const text = await response.text();
  options.signal?.throwIfAborted();
  const files = templateFiles(text);
  if (!files) throw new Error(`${templateFile}: invalid project files`);
  measureStartup("template", started);
  return files;
}

/**
 * Durable 3-step template replacement:
 * 1. Remove `app` and flush (`SEED_MARKER` durably absent).
 * 2. Recreate `app`, write all files, and flush (all files durably present).
 * 3. Create `initialized` marker and flush (`SEED_MARKER` durably present only after all files).
 */
export async function writeTemplateSources(
  fs: Pick<Filesystem, "lookup" | "remove" | "mkdirp" | "writeFile" | "flush">,
  app: string,
  files: TemplateSources,
  reset = false,
  options: { beforeFirstMutation?: () => void } = {},
): Promise<TemplateSources> {
  const initialized = `${app}/.bunwasm-initialized`;
  if (reset || !(await fs.lookup(initialized))) {
    options.beforeFirstMutation?.();
    await fs.remove(app);
    if (reset) await fs.flush();
    await fs.mkdirp(app);
    for (const [path, text] of Object.entries(files)) await fs.writeFile(`${app}/${path}`, text);
    if (reset) await fs.flush();
    await fs.mkdirp(initialized);
    await fs.flush();
  }
  return files;
}

/** Fetches the template and seeds `app` with it on first use or reset. */
export async function loadTemplate(
  fs: Pick<Filesystem, "lookup" | "remove" | "mkdirp" | "writeFile" | "flush">,
  app: string,
  templateFile: string,
  reset = false,
  options: { signal?: AbortSignal; beforeFirstMutation?: () => void } = {},
): Promise<TemplateSources> {
  const files = await fetchTemplateSources(templateFile, { signal: options.signal });
  return writeTemplateSources(fs, app, files, reset, { beforeFirstMutation: options.beforeFirstMutation });
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
