export function spawnStartError(executable: string, code: "ENOENT" | "EACCES"): Error & { code: string; errno: number; path: string } {
  if (code === "EACCES") return Object.assign(new Error(`EACCES: permission denied, posix_spawn '${executable}'`), {
    code, errno: -13, path: executable, syscall: "posix_spawn",
  });
  return Object.assign(new Error(`Executable not found in $PATH: "${executable}"`), { code, errno: -2, path: executable });
}
