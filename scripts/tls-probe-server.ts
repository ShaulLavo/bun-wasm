import { readFileSync } from "node:fs";
import { createServer, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

export const tlsProbeServerPath = fileURLToPath(import.meta.url);

function exchange(socket: TLSSocket, observation: { applicationBytes: number }): void {
  process.stdout.write(
    `secure version=${socket.getProtocol()} alpn=${socket.alpnProtocol} sni=${socket.servername}\n`,
  );
  const chunks: Buffer[] = [];
  socket.on("error", () => {});
  socket.on("data", (data) => {
    if (typeof data === "string")
      throw new Error("TLS fixture requires binary data");
    observation.applicationBytes += data.byteLength;
    process.stdout.write(`application-bytes=${observation.applicationBytes}\n`);
    if (observation.applicationBytes > 17) {
      socket.destroy(new Error("Unexpected application byte count"));
      return;
    }
    chunks.push(data);
    if (observation.applicationBytes < 17) return;
    const payload = Buffer.concat(chunks);
    if (payload.toString() !== "tls-probe-payload")
      throw new Error("Unexpected application bytes");
    process.stdout.write("payload=ok\n");
    socket.end(payload);
  });
  socket.on("end", () => process.stdout.write("peer-close-notify=ok\n"));
}

function main(): void {
  if (process.versions.bun)
    throw new Error("The independent TLS oracle must run on native Node");
  const [key, cert, version] = process.argv.slice(2);
  if (!key || !cert || (version !== "TLSv1.2" && version !== "TLSv1.3"))
    throw new Error("Expected key, certificate, TLS version");
  const observation = { applicationBytes: 0 };
  let connections = 0;
  const server = createServer(
    {
      key: readFileSync(key),
      cert: readFileSync(cert),
      minVersion: version,
      maxVersion: version,
      ALPNProtocols: ["probe/1"],
    },
    socket => exchange(socket, observation),
  );
  server.on("connection", socket => {
    connections += 1;
    if (connections !== 1) throw new Error("TLS oracle expects exactly one connection");
    socket.once("close", () => process.stdout.write(`terminal applicationBytes=${observation.applicationBytes}\n`));
  });
  server.on("tlsClientError", (error) =>
    process.stderr.write(`${error.message}\n`),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing TCP fixture address");
    process.stdout.write(`listening ${address.port}\n`);
  });
}

if (import.meta.main) main();
