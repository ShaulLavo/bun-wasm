declare namespace BunWasm {
  interface Native {
    readonly engine: "quickjs" | "jsc" | "host";
    globMatch(pattern: string, path: string): boolean;
    globScan(pattern: string, cwd: string, dot: boolean, absolute: boolean, followSymlinks: boolean,
      throwErrorOnBrokenSymlink: boolean, onlyFiles: boolean, followMatchedSymlinks?: boolean): string[];
  }

  type GlobScanOptions = Parameters<Native["globScan"]> extends [pattern: string, ...options: infer Options] ? Options : never;

  interface Internal {
    readonly native: Native;
    require(name: "path"): { resolve(...paths: string[]): string };
  }
}

declare const process: { cwd(): string };
declare const Buffer: unknown;
