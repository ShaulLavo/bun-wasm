import fs, { closeSync, openSync, readFileSync, writeSync, writevSync } from "node:fs";

// Only a non-negative safe integer is a write position; any other number or a BigInt
// writes at the current file offset, as Node's GetOffset does.
const positions: [string, unknown][] = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["1.5", 1.5],
  ["MAX_SAFE_INTEGER+1", Number.MAX_SAFE_INTEGER + 1],
  ["5n", 5n],
  ["-1", -1],
  ["null", null],
  ["0", 0],
  ["3", 3],
];

function run(label: string, write: (fd: number) => void): string {
  const path = `${label}.txt`;
  const fd = openSync(path, "w");
  try {
    writeSync(fd, "AAAAAAAAAA");
    write(fd);
  } finally {
    closeSync(fd);
  }
  return readFileSync(path, "utf8");
}

for (const [label, position] of positions) {
  const buffer = run(`buffer-${label}`, fd => writeSync(fd, Buffer.from("XX"), 0, 2, position as number));
  const string = run(`string-${label}`, fd => writeSync(fd, "YY", position as number));
  const vector = run(`vector-${label}`, fd => writevSync(fd, [Buffer.from("VV")], position as number));
  console.log(label, buffer, string, vector);
}

for (const [label, position] of positions) {
  const path = `callback-${label}.txt`;
  const fd = openSync(path, "w");
  writeSync(fd, "AAAAAAAAAA");
  await new Promise<void>((resolve, reject) => fs.write(fd, Buffer.from("ZZ"), 0, 2, position as number, error => (error ? reject(error) : resolve())));
  closeSync(fd);
  console.log("callback", label, readFileSync(path, "utf8"));
}
