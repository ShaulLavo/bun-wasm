// An ES module in TypeScript, loaded with require(), whose error nobody catches.
type Port = number;

interface Server {
  port: Port;
}

export function listen(server: Server): Port {
  if (server.port > 65535) throw new RangeError(`port out of range: ${server.port}`);
  return server.port;
}
