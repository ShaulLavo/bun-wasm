const fd = Number(process.argv[2] || 1);
const stream = fd === 2 ? process.stderr : process.stdout;
for (;;) {
  stream.write("x".repeat(65536), (error: NodeJS.ErrnoException | null | undefined) => {
    if (error) process.exit(error.code === "EPIPE" && error.errno === -32 && error.syscall === "write" ? 42 : 43);
  });
  await new Promise(setImmediate);
}
