// node:http and node:net servers inside the guest.
const http = require("node:http");
const net = require("node:net");

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("x-method", req.method);
    res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "text/plain" });
    res.end(`${req.method} ${req.url} ${req.headers["x-test"] ?? "-"} ${body}`);
  });
});
server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  console.log("http listening:", port > 0);
  const res = await fetch(`http://127.0.0.1:${port}/path?q=1`, { method: "POST", headers: { "x-test": "yes" }, body: "hi" });
  console.log("fetch:", res.status, res.headers.get("x-method"), await res.text());
  http.get(`http://127.0.0.1:${port}/missing`, (msg) => {
    let data = "";
    msg.on("data", (c) => (data += c));
    msg.on("end", () => {
      console.log("http.get:", msg.statusCode, msg.headers["content-type"], data);
      server.close(() => {
        console.log("http closed");
        tcp();
      });
    });
  });
});

function tcp() {
  const echo = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(`echo:${data}`));
    socket.on("end", () => socket.end());
  });
  echo.listen(0, "127.0.0.1", () => {
    const client = net.connect(echo.address().port, "127.0.0.1", () => client.write("ping"));
    client.setEncoding("utf8");
    client.on("data", (data) => {
      console.log("net:", data);
      client.end();
      echo.close(() => console.log("net closed"));
    });
  });
}
