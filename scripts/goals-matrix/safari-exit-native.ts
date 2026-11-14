import { dlopen, ptr, read } from "bun:ffi";
import { openExit, type ExitSyscalls } from "./safari-exit-syscalls";

/** Public kevent64 ABI qualified on Darwin ARM64; loading is opt-in and Darwin-only. */
function nativeExitSyscalls(): ExitSyscalls & { dispose(): void } {
  if (process.platform !== "darwin") throw new Error("Native exit observation requires macOS");
  const system = dlopen("/usr/lib/libSystem.B.dylib", {
    kqueue: { args: [], returns: "i32" },
    kevent64: { args: ["i32", "ptr", "i32", "ptr", "i32", "u32", "ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  return {
    kqueue: system.symbols.kqueue,
    kevent64: (fd, change, event, timeout) => system.symbols.kevent64(fd, change ? ptr(change) : null, change ? 1 : 0, ptr(event), 1, 1, ptr(timeout)),
    close: system.symbols.close,
    errno: () => { const pointer = system.symbols.__error(); return pointer ? read.i32(pointer) : -1; },
    dispose: () => system.close(),
  };
}

export function nativeExitFactory() {
  const system = nativeExitSyscalls();
  return { open: (pid: number) => openExit(system, pid), dispose: () => system.dispose() };
}
