declare namespace BunWasm {
  interface Native {
    exists(path: string): boolean;
    resolve(specifier: string, importer: string, require: boolean): string;
    readFileUtf8(path: string): string;
    readdir(path: string): [string, "dir" | "symlink" | "file" | "other"][];
    readlink(path: string): string;
    stat(path: string, lstat?: boolean): { mode: number };
    mainArg(): string;
    setMainPath(path: string): void;
  }
  interface Internal {
    mainPath: string;
    require(name: "package_scripts"): { resolve(requested: string): string; spawnArguments(argv: string[], directory: unknown): string[] };
  }
}
