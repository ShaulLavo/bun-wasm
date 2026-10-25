export const browserLauncher = `process.env.NEXT_TELEMETRY_DISABLED = "1";
process.env.ASTRO_TELEMETRY_DISABLED = "1";
process.argv.splice(1, 1);
await import("./" + process.argv[1]);
`;

export function browserCommand(args: readonly string[]): string[] {
  if (args[0] !== "run") return ["bun"].concat(args);
  if (!args[1]) throw new Error("Expected a real package or fixture entrypoint");
  return ["bun", "run", ".matrix-command.ts"].concat(args.slice(1));
}

export function registryReplayUrl(url: string, registry: string): string | null {
  if (url !== "https://registry.npmjs.org/-/package/next/dist-tags") return null;
  return `${registry}/-/package/next/dist-tags`;
}
