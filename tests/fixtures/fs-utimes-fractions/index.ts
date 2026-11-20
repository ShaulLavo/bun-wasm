import fs, { closeSync, openSync, promises, statSync, utimesSync, writeFileSync } from "node:fs";

// Sub-second times keep their fraction: seconds as numbers and strings, Dates by their
// milliseconds, and a fraction that rounds up to a whole second.
writeFileSync("f.txt", "x");
const times = () => {
  const stats = statSync("f.txt");
  return `${stats.atimeMs} ${stats.mtimeMs} ${stats.mtime.toISOString()}`;
};

utimesSync("f.txt", 1_700_000_000.25, 1_700_000_001.5);
console.log("fractional seconds", times());
utimesSync("f.txt", "1700000002.75", "1700000003.125");
console.log("numeric strings", times());
utimesSync("f.txt", new Date(1_700_000_004_321), new Date("2045-04-30T19:32:12.333Z"));
console.log("dates", times());
utimesSync("f.txt", new Date("2098-01-01T00:00:00.001Z"), new Date("2100-06-15T12:00:00.5Z"));
console.log("after 2038", times());
utimesSync("f.txt", "-1e-17", "1e-3");
console.log("rounds to the epoch", times());
fs.lutimesSync("f.txt", 1_600_000_000.5, 1_600_000_001.75);
console.log("lutimes", times());
const fd = openSync("f.txt", "r+");
fs.futimesSync(fd, new Date(1_500_000_000_123), "1500000001.5");
closeSync(fd);
console.log("futimes", times());
await promises.utimes("f.txt", 1_400_000_000.5, new Date(1_400_000_001_250));
console.log("promises", times());
const big = statSync("f.txt", { bigint: true });
console.log("bigint", big.atimeNs, big.atimeMs, big.mtimeNs, big.mtimeMs);
