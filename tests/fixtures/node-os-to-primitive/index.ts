import os from "node:os";

// node:os value functions print as functions and convert to their value, as Node's
// Symbol.toPrimitive does: `${os.arch}` is the architecture.
const names = ["arch", "availableParallelism", "endianness", "freemem", "homedir", "hostname", "platform", "release", "tmpdir", "totalmem", "type", "uptime", "version", "machine"] as const;
for (const name of names) {
  const fn = os[name] as (() => unknown) & { [Symbol.toPrimitive]?: unknown };
  const sameType = typeof (fn as unknown as number + 0) === typeof ((fn() as number) + 0);
  console.log(name, typeof fn, fn.toString().startsWith("function"), String(fn).startsWith("function"), typeof fn[Symbol.toPrimitive], fn.name, sameType);
}
// Values that cannot change within one run must convert to exactly their call result.
for (const name of ["arch", "endianness", "homedir", "hostname", "platform", "release", "tmpdir", "type", "version", "machine", "availableParallelism", "totalmem"] as const) {
  const fn = os[name];
  console.log("equal", name, `${fn}` === `${fn()}`, fn + "" === fn() + "");
}
console.log("numeric", typeof (+os.availableParallelism), +os.availableParallelism === os.availableParallelism());
console.log("non-value exports stay plain", typeof (os.cpus as unknown as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive]);
