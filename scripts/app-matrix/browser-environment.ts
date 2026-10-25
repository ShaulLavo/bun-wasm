import type { RuntimeFilesystem } from "waffle";

declare global {
  var playground: { fs: Pick<RuntimeFilesystem, "remove" | "mkdirp"> };
}

export const browserLauncher = `import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
process.env.NEXT_TELEMETRY_DISABLED = "1";
process.env.ASTRO_TELEMETRY_DISABLED = "1";
process.argv.splice(1, 1);
process.argv[1] = resolve(dirname(fileURLToPath(import.meta.url)), process.argv[1]);
await import(pathToFileURL(process.argv[1]).href);
`;

export function browserCommand(args: readonly string[]): string[] {
  if (args[0] !== "run") return ["bun"].concat(args);
  if (!args[1]) throw new Error("Expected a real package or fixture entrypoint");
  return ["bun", "run", ".matrix-command.ts"].concat(args.slice(1));
}

export async function resetBrowserProject(): Promise<void> {
  await globalThis.playground.fs.remove("/home/user");
  await globalThis.playground.fs.mkdirp("/home/user");
}
