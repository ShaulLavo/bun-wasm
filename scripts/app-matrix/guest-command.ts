import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function prepareGuestProject(scratch: string, name: string, files: Readonly<Record<string, string>>) {
  const root = join(scratch, name);
  const path = join(root, "app");
  mkdirSync(root);
  try {
    mkdirSync(join(path, "tmp"), { recursive: true });
    mkdirSync(join(path, ".cache"));
    for (const [file, contents] of Object.entries(files)) {
      const destination = join(path, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    return { root, path };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

type GuestProject = ReturnType<typeof prepareGuestProject>;

export async function withGuestProject<Result>(project: GuestProject, run: (project: GuestProject) => Promise<Result>): Promise<Result> {
  try { return await run(project); }
  finally { rmSync(project.root, { recursive: true, force: true }); }
}

interface GuestCommand {
  host: readonly string[];
  project: GuestProject;
  args: readonly string[];
  port: number;
  registry: string;
}

export function guestCommand({ host, project, args, port, registry }: GuestCommand): string[] {
  const env = { PWD: "/app", HOME: "/app", TMPDIR: "/app/tmp", PORT: String(port), NO_COLOR: "1", CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_ENGINES_MIRROR: `${registry}/blocked-prisma-engines`, BUN_INSTALL_CACHE_DIR: "/app/.cache", BUN_WASM_TRACE_EXIT: "1" };
  const dirs = ["--dir", `${project.root}::/`, "--dir", `${project.path}::/app`];
  const vars = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return host.concat(dirs, vars, ["--"], args);
}
