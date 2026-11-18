import fs, { writeFileSync } from "node:fs";

// fs calls reject an encoding Buffer does not know, synchronously and with Bun's
// messages, and still accept every real encoding, "buffer" and a missing one.
writeFileSync("file.txt", "héllo");
const failure = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    const value = error as Error & { code?: string };
    return `${value.name} ${value.code} ${value.message}`;
  }
};
const noop = () => {};
const cases: [string, () => unknown][] = [
  ["readFileSync", () => fs.readFileSync("file.txt", "test" as never)],
  ["readFile", () => fs.readFile("file.txt", "test" as never, noop)],
  ["readFileSync object", () => fs.readFileSync("file.txt", { encoding: "nope" as never })],
  ["writeFileSync", () => fs.writeFileSync("out.txt", "data", "test" as never)],
  ["writeFile", () => fs.writeFile("out.txt", "data", "test" as never, noop)],
  ["appendFileSync", () => fs.appendFileSync("out.txt", "data", "test" as never)],
  ["appendFile", () => fs.appendFile("out.txt", "data", "test" as never, noop)],
  ["readdirSync", () => fs.readdirSync(".", "test" as never)],
  ["readdir", () => fs.readdir(".", "test" as never, noop)],
  ["readlinkSync", () => fs.readlinkSync("file.txt", "test" as never)],
  ["readlink", () => fs.readlink("file.txt", "test" as never, noop)],
  ["realpathSync", () => fs.realpathSync("file.txt", "test" as never)],
  ["realpath", () => fs.realpath("file.txt", "test" as never, noop)],
  ["mkdtempSync", () => fs.mkdtempSync("tmp-", "test" as never)],
  ["mkdtemp", () => fs.mkdtemp("tmp-", "test" as never, noop)],
  ["ReadStream", () => fs.ReadStream("file.txt", "test" as never)],
  ["WriteStream", () => fs.WriteStream("stream-out.txt", { encoding: "test" as never })],
];
for (const [label, run] of cases) console.log(label, failure(run));
console.log("out.txt written", fs.existsSync("out.txt"));

for (const encoding of ["utf8", "UTF-8", "latin1", "hex", "base64", "ucs2", "buffer", null, undefined] as const) {
  const value = fs.readFileSync("file.txt", encoding as never);
  console.log("valid", String(encoding), typeof value === "string" ? value : `Buffer(${(value as Buffer).length})`);
}
console.log("realpath valid", fs.realpathSync("file.txt", "utf8").endsWith("file.txt"), "readdir valid", fs.readdirSync(".", { encoding: "utf8" }).includes("file.txt"));
fs.writeFileSync("buffer-encoding.txt", "wrïte", { encoding: "buffer" });
console.log("write with buffer encoding", fs.readFileSync("buffer-encoding.txt", "utf8"));
