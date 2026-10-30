import fs from "node:fs";

fs.mkdirSync("metadata-dir");
fs.writeFileSync("metadata-dir/config.ts", "export default {};\n");
fs.symlinkSync("config.ts", "metadata-dir/config-link.ts");
const descriptor = fs.openSync("metadata-dir/config.ts", "r");
try {
  const file = fs.statSync("metadata-dir/config.ts");
  const link = fs.lstatSync("metadata-dir/config-link.ts");
  const directory = fs.statSync("metadata-dir");
  if (!file.isFile() || !link.isSymbolicLink() || !directory.isDirectory()) throw new Error("metadata lost its file type");
  const modes = [file.mode, link.mode, directory.mode, fs.fstatSync(descriptor).mode];
  if (modes.some(mode => !(mode & 0o400))) throw new Error("readable fixture presented without owner-read permission");
  const bigint = fs.statSync("metadata-dir/config.ts", { bigint: true });
  if (!(bigint.mode & 0o400n) || !bigint.isFile()) throw new Error("bigint metadata lost its readable file type");
  console.log("readable metadata retained file types");
} finally {
  fs.closeSync(descriptor);
}
