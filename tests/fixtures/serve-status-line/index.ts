// The status line native Bun.serve writes for a Response's status and statusText.
import net from "node:net";

const cases: [number, string | undefined][] = [[200, undefined], [200, ""], [200, "Fine"], [404, undefined], [599, undefined], [299, ""]];
await using server = Bun.serve({
  port: 0,
  fetch(req) {
    const [status, statusText] = cases[Number(new URL(req.url).pathname.slice(1))];
    return new Response("x", statusText === undefined ? { status } : { status, statusText });
  },
});
for (let i = 0; i < cases.length; i++) {
  const line = await new Promise<string>(resolve => {
    const socket = net.connect(server.port!, "127.0.0.1", () => socket.write(`GET /${i} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let raw = "";
    socket.on("data", data => (raw += data.toString("latin1")));
    socket.on("close", () => resolve(raw.split("\r\n")[0]));
  });
  console.log(JSON.stringify(cases[i]), JSON.stringify(line));
}

// node:http: writeHead() sends Node's text ("unknown" when it has none); a head written for
// the program (statusCode, then end()) sends Bun's reason phrase, "HM" when it has none.
const http = await import("node:http");
const nodeServer = http.createServer((req, res) => {
  const [how, code, message] = req.url!.slice(1).split("/");
  if (how === "write") res.writeHead(Number(code));
  else res.statusCode = Number(code);
  if (message) res.statusMessage = message;
  res.end("x");
});
await new Promise<void>(resolve => nodeServer.listen(0, "127.0.0.1", () => resolve()));
const nodePort = (nodeServer.address() as import("node:net").AddressInfo).port;
for (const path of ["write/299", "implicit/299", "write/203", "implicit/203", "implicit/599", "implicit/599/Custom", "implicit/200"]) {
  const line = await new Promise<string>(resolve => {
    const socket = net.connect(nodePort, "127.0.0.1", () => socket.write(`GET /${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let raw = "";
    socket.on("data", data => (raw += data.toString("latin1")));
    socket.on("close", () => resolve(raw.split("\r\n")[0]));
  });
  console.log("node:http", path, JSON.stringify(line));
}
nodeServer.close();
