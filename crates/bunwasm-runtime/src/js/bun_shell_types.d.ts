declare namespace BunWasm {
  interface ShellFs {
    writeFileSync(path: string, data: Uint8Array): void;
    readFileSync(path: string): BufferBytes;
    existsSync(path: string): boolean;
    rmSync(path: string, options: { force: boolean }): void;
  }
  interface Internal {
    BunFile: abstract new (...args: never[]) => { name?: unknown };
    require(name: "fs"): ShellFs;
    require(name: "spawn"): { spawn(argv: string[], options: Record<string, unknown>): WorkerChild; which(command: string, options?: { PATH?: string; cwd?: string }): string | null };
    require(name: "bun_shell"): { $: Function; findShell(env: Record<string, string | undefined>, cwd: string): string };
  }
}
