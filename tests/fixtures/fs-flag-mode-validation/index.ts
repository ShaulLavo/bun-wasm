import fs, { closeSync, existsSync, mkdirSync, openSync, promises, rmSync, statSync, writeFileSync } from "node:fs";

// open flags and file modes are validated the way Node's stringToFlags, validateInt32
// and parseFileMode do, with Node's error codes and messages.
const failure = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    const value = error as Error & { code?: string };
    return `${value.constructor.name} ${value.code} ${value.message}`;
  }
};

for (const flags of ["W", "R+", "A", "577", "rw", "", {}, 578.5, 2 ** 31, Number.NaN]) {
  console.log("flags", typeof flags === "string" ? JSON.stringify(flags) : String(flags), failure(() => openSync("flags.txt", flags as never)), existsSync("flags.txt"));
}
for (const flags of ["r+", "w", "wx", "xa+", "as+", "sa+"] as const) {
  const result = failure(() => closeSync(openSync("valid-flags.txt", flags)));
  console.log("valid flags", flags, result);
  rmSync("valid-flags.txt", { force: true });
}

for (const mode of ["0o755", "+755", "7_5_5", "888", "7a5", "", "7•5", "㜷", "40000000000", -1, 1.5, true]) {
  console.log("mode", JSON.stringify(mode), failure(() => openSync("mode.txt", "w", mode as never)), existsSync("mode.txt"));
}
for (const mode of ["755", "0644", "0", "37777777777", 0o600]) {
  const result = failure(() => closeSync(openSync("valid-mode.txt", "w", mode)));
  console.log("valid mode", JSON.stringify(mode), result);
  rmSync("valid-mode.txt", { force: true });
}

console.log("mkdir mode", failure(() => mkdirSync("sub", { mode: "7a5" as never })), existsSync("sub"));
console.log("mkdir mode number argument", failure(() => mkdirSync("sub2", -1 as never)), existsSync("sub2"));
console.log("writeFile mode", failure(() => writeFileSync("written.txt", "x", { mode: "0o644" as never })), existsSync("written.txt"));
console.log("readFile flag", failure(() => fs.readFileSync("written.txt", { flag: "R" })));
writeFileSync("default-flag.txt", "b", { flag: undefined });
writeFileSync("null-flag.txt", "c", { flag: null as never });
console.log("null flag means default", fs.readFileSync("default-flag.txt", { encoding: "utf8", flag: null as never }), fs.readFileSync("null-flag.txt", "utf8"));

console.log("callback open throws", failure(() => fs.open("cb.txt", "W", () => console.log("callback ran"))), existsSync("cb.txt"));
console.log("callback mkdir throws", failure(() => fs.mkdir("cb-dir", { mode: "x" as never }, () => console.log("callback ran"))));
await promises.open("p.txt", "W").then(() => console.log("promise opened"), error => console.log("promise rejects", (error as { code?: string }).code));
await new Promise<void>(resolve => fs.open("missing/deep.txt", "r", error => {
  console.log("system error goes to callback", (error as NodeJS.ErrnoException | null)?.code);
  resolve();
}));
writeFileSync("mode-check.txt", "x", { mode: "0600" as never });
console.log("string mode applied", statSync("mode-check.txt").isFile());

mkdirSync("nonblock-dir", { recursive: true });
writeFileSync("nonblock-dir/hello.txt", "hi");
const dirFd = openSync("nonblock-dir", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK);
closeSync(dirFd);
console.log("nonblock directory open", "ok");
