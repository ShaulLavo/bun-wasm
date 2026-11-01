import { readFileSync } from "node:fs";
import { createServer } from "node:tls";

if (process.versions.bun) throw new Error("The independent TLS oracle must run on native Node");
const [key, cert, version] = process.argv.slice(2);
if (!key || !cert || (version !== "TLSv1.2" && version !== "TLSv1.3")) throw new Error("Expected key, certificate, TLS version");
const server = createServer({
  key: readFileSync(key), cert: readFileSync(cert),
  minVersion: version, maxVersion: version, ALPNProtocols: ["probe/1"],
}, socket => {
  process.stdout.write(`secure version=${socket.getProtocol()} alpn=${socket.alpnProtocol} sni=${socket.servername}\n`);
  const chunks: Buffer[] = [];
  socket.on("error", () => {});
  socket.on("data", data => {
    if (typeof data === "string") throw new Error("TLS fixture requires binary data");
    chunks.push(data);
    if (Buffer.concat(chunks).byteLength < 17) return;
    const payload = Buffer.concat(chunks);
    if (payload.toString() !== "tls-probe-payload") throw new Error("Unexpected application bytes");
    process.stdout.write("payload=ok\n");
    socket.end(payload);
  });
  socket.on("end", () => process.stdout.write("peer-close-notify=ok\n"));
});
server.on("tlsClientError", error => process.stderr.write(`${error.message}\n`));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP fixture address");
  process.stdout.write(`listening ${address.port}\n`);
});
