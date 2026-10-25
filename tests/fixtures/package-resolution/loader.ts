import { createRequire } from "node:module";

export const loadRequire = createRequire(import.meta.url);

export function loadImport(specifier: string) {
  return import(specifier);
}
