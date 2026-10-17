export function executableNotFound(executable: string): Error & { code: string; errno: number; path: string } {
  return Object.assign(new Error(`Executable not found in $PATH: "${executable}"`), {
    code: "ENOENT", errno: -2, path: executable,
  });
}
