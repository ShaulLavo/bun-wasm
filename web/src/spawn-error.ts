export function spawnStartError(executable: string, code: "ENOENT" | "EACCES"): Error & { code: string; errno: number; path: string } {
  const message = code === "ENOENT" ? `Executable not found in $PATH: "${executable}"` : `Permission denied: "${executable}"`;
  return Object.assign(new Error(message), { code, errno: code === "ENOENT" ? -2 : -13, path: executable });
}
