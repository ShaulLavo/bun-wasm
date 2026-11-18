type FsStatfsError = Error & { code?: unknown; syscall?: unknown };

// fs.statfsSync. WASI has no statfs, so an existing path reports ENOSYS, the error
// libuv gives where the call is missing. A missing path still reports ENOENT with
// syscall "statfs", as Node and Bun do. The callback and promise forms derive from it.
(() => (statSync: (path: unknown) => unknown, toPath: (path: unknown) => string) => function statfsSync(path: unknown): never {
  "use strict";
  const given = toPath(path);
  try {
    statSync(path);
  } catch (error) {
    const failure = error as FsStatfsError;
    if (failure?.code !== "ENOENT") throw error;
    failure.message = failure.message.replace(`, ${String(failure.syscall)} '`, ", statfs '");
    failure.syscall = "statfs";
    throw failure;
  }
  throw Object.assign(new Error(`ENOSYS: function not implemented, statfs '${given}'`), { errno: -38, code: "ENOSYS", syscall: "statfs", path: given });
})
