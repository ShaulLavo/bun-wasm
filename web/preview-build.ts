import { join } from "node:path";

/** Bundle a page script that uses the shared runtime WebSocket client, without evaluating source inside the page. */
async function runtimeWebsocketBundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "browser", format: "iife", minify: true,
    plugins: [{
      name: "runtime-websocket-factory",
      setup(build) {
        build.onResolve({ filter: /^bun-wasm:websocket$/ }, () => ({ path: join(import.meta.dir, "../crates/bunwasm-runtime/src/js/websocket.ts") }));
        build.onLoad({ filter: /bunwasm-runtime\/src\/js\/websocket\.ts$/ }, async ({ path }) => ({
          contents: `export default ${await Bun.file(path).text()}`,
          loader: "ts",
        }));
      },
    }],
  });
  if (!result.success) throw new Error(`Preview WebSocket build failed: ${result.logs.join("\n")}`);
  return result.outputs[0]!.text();
}

/** The WebSocket shim of mounted `/__preview/` pages. */
export function previewWebsocketScript(): Promise<string> {
  return runtimeWebsocketBundle("src/preview-websocket-client.ts");
}

/** The page shim of preview origins: the same WebSocket client plus cookies and frame reports. */
export function previewOriginShimScript(): Promise<string> {
  return runtimeWebsocketBundle("src/preview-origin/page-shim.ts");
}
