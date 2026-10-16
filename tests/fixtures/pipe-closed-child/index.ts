const buffered = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
const bufferedReader = buffered.getReader();
await bufferedReader.cancel();
if (!(await bufferedReader.read()).done) throw new Error("cancel kept buffered output");

for (const fd of [1, 2]) {
  for (const handled of [false, true]) {
    const name = fd === 2 ? "stderr" : "stdout";
    const source = `
      const stream = process.${name};
      ${handled ? 'stream.on("error", error => process.exit(error.code === "EPIPE" && error.errno === -32 ? 42 : 43));' : ""}
      const chunk = "x".repeat(65536);
      for (;;) stream.write(chunk);
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const reader = child[name].getReader();
    const first = await reader.read();
    if (first.done || !first.value.byteLength) throw new Error("child did not reach its output loop");
    await reader.cancel();
    const other = fd === 2 ? child.stdout : child.stderr;
    const drained = new Response(other).text();
    const code = await child.exited;
    await drained;
    console.log("closed child", name, handled, code);
    if (code !== (handled ? 42 : 1)) throw new Error("closed child did not report EPIPE");
  }
}

for (const fd of [1, 2]) {
  const name = fd === 2 ? "stderr" : "stdout";
  const source = `
    const source = 'process.${name}.on("error", e => process.exit(e.code === "EPIPE" ? 42 : 43)); for (;;) process.${name}.write("x".repeat(65536));';
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const reader = child[name].getReader();
  const first = await reader.read();
  if (first.done || !first.value.byteLength) throw new Error("inherited child did not reach its output loop");
  await reader.cancel();
  const drained = new Response(fd === 2 ? child.stdout : child.stderr).text();
  const code = await child.exited;
  await drained;
  console.log("closed inherited child", name, code);
  if (code !== 42) throw new Error("inherited output did not report EPIPE");
}
