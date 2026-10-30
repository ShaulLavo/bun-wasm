interface GuestCommand {
  host: readonly string[];
  project: string;
  args: readonly string[];
  port: number;
  registry: string;
}

export function guestCommand({ host, project, args, port, registry }: GuestCommand): string[] {
  const env = { PWD: "/app", HOME: "/app", TMPDIR: "/app/tmp", PORT: String(port), NO_COLOR: "1", CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_ENGINES_MIRROR: `${registry}/blocked-prisma-engines`, BUN_INSTALL_CACHE_DIR: "/app/.cache", BUN_WASM_TRACE_EXIT: "1" };
  const dirs = ["--dir", `${project}::/app`];
  const vars = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return host.concat(dirs, vars, ["--"], args);
}
