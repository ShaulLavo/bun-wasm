import { join } from "node:path";

/** Bundle the shared runtime client without evaluating source inside the preview page. */
export async function previewWebsocketScript(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/preview-websocket-client.ts")],
    target: "browser", format: "iife", minify: true,
    plugins: [{
      name: "runtime-websocket-factory",
      setup(build) {
        build.onLoad({ filter: /bunwasm-runtime\/src\/js\/websocket\.js$/ }, async ({ path }) => ({
          contents: `export default ${await Bun.file(path).text()}`,
          loader: "js",
        }));
      },
    }],
  });
  if (!result.success) throw new Error(`Preview WebSocket build failed: ${result.logs.join("\n")}`);
  return result.outputs[0]!.text();
}
