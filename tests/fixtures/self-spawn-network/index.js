const child = Bun.spawn([process.execPath, "-e", `
  const server = Bun.serve({ port: 0, fetch() { return new Response("child response"); } });
  console.log(server.port);
  console.error("ready");
`], { stdout: "pipe", stderr: "pipe" });
const reader = child.stdout.getReader();
const { value } = await reader.read();
const port = Number(new TextDecoder().decode(value).trim());
console.log("child server", await (await fetch(`http://127.0.0.1:${port}/`)).text());
child.kill();
console.log("stopped", await child.exited);
const replacement = Bun.serve({ port, fetch() { return new Response("parent response"); } });
console.log("port released", await (await fetch(`http://127.0.0.1:${port}/`)).text());
replacement.stop();
