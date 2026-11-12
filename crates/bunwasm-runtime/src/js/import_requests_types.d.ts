export {};
declare global {
namespace BunWasm {
  type ImportMode = "inferred" | "text";
  type ImportJob<T> = (specifier: string, mode: ImportMode, resolve: (value: T) => void, reject: (error: unknown) => void) => void;
  interface ImportRequests {
    request<T>(specifier: unknown, options: unknown, load: ImportJob<T>): Promise<T>;
    resolve(specifier: string, referrer: string, mode: ImportMode): string;
  }
  interface Internal { importRequests: ImportRequests; }
}

interface GlobalThis {
  __bunwasm_importRequests?: BunWasm.ImportRequests;
}
var __bunwasm_importRequests: BunWasm.ImportRequests | undefined;
var __bunwasm_initializeImportRequests: ((imports: BunWasm.ImportRequests) => void) | undefined;
}
