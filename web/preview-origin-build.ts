// Builds what preview origins need (docs/preview-origins.md):
//
//   <out>/__preview-origin/{sw.js,relay.html,bootstrap.html,top.html}   served by the preview host
//   <out>/preview-frame.html                                            the IDE-origin new-tab wrapper
//
// BUN_WASM_PREVIEW_ORIGIN=<domain> (for example "sprockt.dev") makes the built pages use preview
// origins. Without it they keep mounted `/__preview/` previews unless a local run asks otherwise.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { previewOriginShimScript } from "./preview-build";
import { IDE_ORIGINS_PLACEHOLDER, type PreviewOriginAsset } from "./src/preview-origin/host";
import { FRAME_PAGE, IDE_ONLY_MESSAGE } from "./src/preview-origin/protocol";

const source = join(import.meta.dir, "src/preview-origin");

async function bundle(entry: string, define?: Record<string, string>): Promise<string> {
  const result = await Bun.build({ entrypoints: [join(source, entry)], target: "browser", format: "iife", minify: true, define });
  if (!result.success) throw new AggregateError(result.logs, `Preview origin build failed: ${entry}`);
  return result.outputs[0]!.text();
}

/** An inline classic script. A bundle never contains a literal closing tag after this. */
function inline(script: string): string {
  return `<script>${script.replaceAll("</script", "<\\/script")}</script>`;
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<style>html,body{height:100%;margin:0}body{font:15px/1.5 system-ui,sans-serif;color:#e6e6e6;background:#14151a}p{margin:0;padding:24px}iframe{display:block;width:100%;height:100%;border:0;background:#fff}</style>`
    + `<body>${body}</body></html>`;
}

/** The domain a build bakes into its pages, or undefined for mounted previews. */
export function builtPreviewOrigin(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env.BUN_WASM_PREVIEW_ORIGIN;
  if (!value) return undefined;
  if (!/^(?:https?:\/\/)?[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) throw new Error(`Invalid BUN_WASM_PREVIEW_ORIGIN: ${value}`);
  return value;
}

/** The startup statement that tells a built page its preview-origin domain. */
export function previewOriginStartup(env: Record<string, string | undefined> = process.env): string {
  const domain = builtPreviewOrigin(env);
  return domain ? `globalThis.__bunwasmPreviewOrigin=${JSON.stringify(domain)};` : "";
}

/** The files a preview host serves, by name. */
export async function previewOriginAssets(): Promise<Record<PreviewOriginAsset, string>> {
  const [shim, relay, bootstrap] = await Promise.all([previewOriginShimScript(), bundle("relay.ts"), bundle("bootstrap.ts")]);
  const worker = await bundle("sw.ts", { __PREVIEW_ORIGIN_SHIM__: JSON.stringify(shim) });
  return {
    "sw.js": worker,
    "relay.html": document("Preview relay", `<script>self.__bunwasmPreviewIdeOrigins=${IDE_ORIGINS_PLACEHOLDER};</script>${inline(relay)}`),
    "bootstrap.html": document("Loading preview", `<p role="status">Starting the preview…</p>${inline(bootstrap)}`),
    "top.html": document("Preview", `<p role="status">${IDE_ONLY_MESSAGE}</p>`),
  };
}

/** Writes the preview host's files and the IDE's wrapper page into a built app. */
export async function writePreviewOriginAssets(out: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const [assets, frame] = await Promise.all([previewOriginAssets(), bundle("frame-entry.ts")]);
  await mkdir(join(out, "__preview-origin"), { recursive: true });
  const startup = previewOriginStartup(env);
  await Promise.all(Object.entries(assets).map(([name, text]) => Bun.write(join(out, "__preview-origin", name), text)).concat(
    Bun.write(join(out, FRAME_PAGE), document("Preview", `${startup ? inline(startup) : ""}${inline(frame)}`)),
  ));
}
