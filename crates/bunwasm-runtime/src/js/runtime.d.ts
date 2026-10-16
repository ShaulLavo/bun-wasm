declare namespace BunWasm {
  interface Native {
    readonly engine: "quickjs" | "jsc" | "host";
    globMatch(pattern: string, path: string): boolean;
    globScan(pattern: string, ...options: (string | boolean)[]): string[];
  }

  interface Internal {
    readonly native: Native;
    require(name: "path"): { resolve(...paths: string[]): string };
  }
}

declare const process: { cwd(): string };
declare const Buffer: unknown;
