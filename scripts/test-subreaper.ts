/** Scope process-wide child subreaping to a test suite, preserving its caller's setting. */
export async function testSubreaper(enabled: boolean): Promise<() => void> {
  if (process.platform !== "linux") return () => {};
  const { dlopen, ptr } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
  const previous = new Int32Array(1);
  const getChildSubreaper = 37, setChildSubreaper = 36;
  if (libc.symbols.prctl(getChildSubreaper, ptr(previous), 0, 0, 0) !== 0) {
    libc.close();
    throw new Error("cannot read test child subreaping");
  }
  if (libc.symbols.prctl(setChildSubreaper, Number(enabled), 0, 0, 0) !== 0) {
    libc.close();
    throw new Error("cannot set test child subreaping");
  }
  return () => {
    try {
      if (libc.symbols.prctl(setChildSubreaper, previous[0]!, 0, 0, 0) !== 0) throw new Error("cannot restore test child subreaping");
    } finally { libc.close(); }
  };
}
