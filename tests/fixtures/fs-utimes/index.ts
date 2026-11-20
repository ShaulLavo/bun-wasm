import fs, { closeSync, lstatSync, openSync, promises, statSync, utimesSync, writeFileSync } from "node:fs";

// utimes, lutimes and futimes set the times they are given, as Bun's time_like.rs reads
// them: seconds (fractions kept), Dates, numeric strings, and a negative number for now.
writeFileSync("f.txt", "x");
const times = (path: string) => {
  const stats = statSync(path);
  return `${stats.atimeMs} ${stats.mtimeMs} ${stats.mtime.toISOString()}`;
};
const describe = (error: unknown) => {
  const { name, code, syscall, message } = error as { name: string; code: string; syscall?: string; message: string };
  return `${name} ${code} ${syscall} ${message}`;
};
const attempt = (label: string, run: () => unknown) => {
  try {
    run();
    console.log(label, "ok", times("f.txt"));
  } catch (error) {
    console.log(label, describe(error));
  }
};

attempt("whole seconds", () => utimesSync("f.txt", 1_700_000_000, 1_700_000_001));
attempt("fractional seconds", () => utimesSync("f.txt", 1_700_000_000.25, 1_700_000_001.5));
attempt("numeric strings", () => utimesSync("f.txt", "1700000002.75", "1700000003"));
attempt("dates", () => utimesSync("f.txt", new Date(1_700_000_004_321), new Date("2045-04-30T19:32:12.333Z")));
attempt("after 2038", () => utimesSync("f.txt", new Date("2098-01-01T00:00:00Z"), new Date("2100-06-15T12:00:00.5Z")));
attempt("epoch", () => utimesSync("f.txt", 0, 0));

// A negative number means the current time.
const before = Date.now() - 2000;
utimesSync("f.txt", -1.5, -1);
const now = statSync("f.txt");
console.log("negative number is now", now.atimeMs >= before, now.mtimeMs >= before);

// lutimes on a regular file and futimes on a descriptor.
fs.lutimesSync("f.txt", 1_600_000_000.5, 1_600_000_001);
console.log("lutimes", times("f.txt"), lstatSync("f.txt").mtimeMs);
const fd = openSync("f.txt", "r+");
fs.futimesSync(fd, new Date(1_500_000_000_123), "1500000001.5");
closeSync(fd);
console.log("futimes", times("f.txt"));

// Times that are not a finite number, a Date or a string are rejected before the call.
attempt("missing atime", () => (utimesSync as (path: string) => void)("f.txt"));
attempt("missing mtime", () => (utimesSync as (path: string, atime: number) => void)("f.txt", 1));
attempt("NaN", () => utimesSync("f.txt", Number.NaN, 1));
attempt("Infinity mtime", () => utimesSync("f.txt", 1, Number.POSITIVE_INFINITY));
attempt("object", () => utimesSync("f.txt", {} as number, 1));
attempt("bigint", () => utimesSync("f.txt", 1n as unknown as number, 1));
attempt("non-numeric string", () => utimesSync("f.txt", "soon", 1));
attempt("invalid date", () => utimesSync("f.txt", new Date(Number.NaN), 1));
attempt("futimes negative fd", () => fs.futimesSync(-1, 1, 1));

// Errors name Node's operation, not the kernel call.
attempt("utimes missing file", () => utimesSync("missing/f.txt", 1, 1));
attempt("lutimes missing file", () => fs.lutimesSync("missing/f.txt", 1, 1));
attempt("futimes bad fd", () => fs.futimesSync(2_147_483_640, 1, 1));

const syscallOf = (error: unknown) => (error as { syscall?: string } | null)?.syscall;
await new Promise<void>((resolve) => fs.utimes("missing/f.txt", 1, 1, (error) => {
  console.log("callback utimes", syscallOf(error));
  resolve();
}));
await new Promise<void>((resolve) => fs.lutimes("missing/f.txt", 1, 1, (error) => {
  console.log("callback lutimes", syscallOf(error));
  resolve();
}));
console.log("promises utimes", await promises.utimes("missing/f.txt", 1, 1).catch(syscallOf));
console.log("promises lutimes", await promises.lutimes("missing/f.txt", 1, 1).catch(syscallOf));
await promises.utimes("f.txt", 1_400_000_000.5, new Date(1_400_000_001_250));
console.log("promises", times("f.txt"));
