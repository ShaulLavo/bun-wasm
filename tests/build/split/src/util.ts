export function log(scope: string, ...args: unknown[]): void {
  console.log(`[${scope}]`, ...args);
}
export const unused = 42;
