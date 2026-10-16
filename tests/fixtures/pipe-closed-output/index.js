const chunk = "x".repeat(64 * 1024);
const fd = Number(process.argv[2] || 1);
const method = process.argv[3] || "stream";
const stream = fd === 2 ? process.stderr : process.stdout;
if (process.argv[4] === "handled") {
  stream.on("error", error => process.exit(error.code === "EPIPE" && error.errno === -32 && error.syscall === "write" ? 42 : 43));
}
function write() {
  if (method === "console") return fd === 2 ? console.error(chunk) : console.log(chunk);
  if (method === "fs") return require("node:fs").writeSync(fd, chunk);
  if (method === "writev") return require("node:fs").writevSync(fd, [Buffer.from(chunk)]);
  return stream.write(chunk);
}
for (;;) write();
