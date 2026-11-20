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
