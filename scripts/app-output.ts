import { join, resolve } from "node:path";

/**
 * Where an app build (web/build.ts, sandbox/build.ts) writes: BUN_WASM_APP_OUT when it names a
 * directory, else the app's own dist. An empty or blank value means the default, so site/build.ts
 * can pin it empty and no app `.env` file can redirect a deploy build.
 */
export function appOutput(app: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BUN_WASM_APP_OUT?.trim();
  return override ? resolve(override) : join(app, "dist");
}
