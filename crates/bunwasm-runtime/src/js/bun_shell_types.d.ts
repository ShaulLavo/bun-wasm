declare namespace BunWasm {
  interface ShellFs {
    writeFileSync(path: string, data: Uint8Array, options?: { flag: string }): void;
    mkdtempSync(prefix: string): string;
    readFileSync(path: string): BufferBytes;
    existsSync(path: string): boolean;
    rmSync(path: string, options: { recursive?: boolean; force: boolean }): void;
  }
  interface Internal {
    BunFile: abstract new (...args: never[]) => { name?: unknown };
    builtin(name: "node:fs"): ShellFs;
    require(name: "spawn"): { spawn(argv: string[], options: Record<string, unknown>): WorkerChild; which(command: string, options?: { PATH?: string; cwd?: string }): string | null };
    require(name: "bun_shell"): { $: Function; findShell(env: Record<string, string | undefined>, cwd: string): string; escape(value: unknown): string };
  }
}
