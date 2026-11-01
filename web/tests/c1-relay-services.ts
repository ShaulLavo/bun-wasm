import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { C1Cleanup, c1SetupReady, type c1Ports, type c1InputPaths } from "./c1-relay-inputs";
import { Server as HttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
async function podman(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execute("podman", args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
async function absent(name: string): Promise<boolean> {
  try { await podman(["container", "exists", name]); return false; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) return true;
    throw error;
  }
}
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}
async function freePort(port: number): Promise<void> {
  const probe = createServer();
  try { await listen(probe, port); } finally { await closeServer(probe); }
}

/** Starts nothing at import time. The caller must complete admitted artifact intake first. */
export async function startC1Services(owner: C1Cleanup, ports: ReturnType<typeof c1Ports>, target: ReturnType<typeof c1InputPaths>["preview1"], signal: AbortSignal) {
  const name = `waffle-net-c1-${crypto.randomUUID()}`;
  const image = process.env.C1_PG_IMAGE ?? "docker.io/library/postgres:16-alpine";
  // Read the baseline before creating anything. Never pull, prune, or remove a borrowed image.
  if (!await absent(name)) throw new Error("C1 refuses to take over an existing container");
  await podman(["image", "inspect", image]);
  for (const value of [ports.page, ports.relay, ports.postgres]) await freePort(value);
  const createRelay = await nativeRelayFactory();
  signal.throwIfAborted();
  owner.add(async () => {
    await podman(["rm", "--force", "--ignore", name]);
    if (!await absent(name)) throw new Error("C1 Postgres container cleanup unconfirmed");
  });
  const password = randomBytes(32).toString("base64url");
  await podman(["run", "--pull=never", "--rm", "--name", name, "--network", "bridge",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=512m", "--publish", `127.0.0.1:${ports.postgres}:5432`,
    "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256", "--detach", image],
  { ...process.env, POSTGRES_PASSWORD: password });
  await postgresReady(name, signal);
  const sockets = new Set<Socket>();
  const echo = createServer({ allowHalfOpen: true }, socket => echoConnection(sockets, socket));
  owner.add(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(echo);
    if (sockets.size || echo.listening) throw new Error("C1 echo cleanup unconfirmed");
  });
  await listen(echo, 0);
  const address = echo.address();
  if (!address || typeof address === "string") throw new Error("C1 echo did not bind IPv4 localhost");
  const secret = randomBytes(32);
  const destinations = [
    { host: "pg.waffle.internal", port: 5432, connect: { host: "127.0.0.1", port: ports.postgres } },
    { host: target.host, port: target.port, connect: { host: "127.0.0.1", port: address.port } },
  ];
  const options = {
    credential: randomBytes(32).toString("hex"), allowedOrigins: [`http://127.0.0.1:${ports.page}`],
    tcp: { tokenSecret: secret, destinations, log() {}, webtransport: { host: "127.0.0.1", port: ports.webtransport, certificate: "rotating-hash" } },
  };
  const relay = createRelay(options);
  owner.add(async () => {
    await relay.close();
    if (relay.server.listening || relay.active() !== 0) throw new Error("C1 relay cleanup unconfirmed");
    secret.fill(0);
  });
  await c1SetupReady(relay.ready, signal);
  await listen(relay.server, ports.relay);
  signal.throwIfAborted();
  return {
    databaseEnvironment: () => ({ PGPASSWORD: password }),
    resources: { container: name, image, page: ports.page, relay: ports.relay, udp: ports.webtransport, postgres: ports.postgres, echo: address.port },
    async token(): Promise<string> {
      const { mintRelayToken } = await import("waffle-relay/token");
      return mintRelayToken(secret, { exp: Math.floor(Date.now() / 1000) + 300, sub: "c1-localhost", dst: destinations.map(({ host, port }) => ({ host, port })) });
    },
  };
}

function echoConnection(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket);
  socket.on("data", bytes => { if (!socket.write(bytes)) socket.pause(); });
  socket.on("drain", () => socket.resume());
  socket.on("end", () => socket.end());
  socket.on("error", () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
}

async function postgresReady(name: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try { await podman(["exec", name, "pg_isready", "-U", "postgres"]); return; }
    catch { await delay(250); }
  }
  throw new Error("C1 Postgres readiness deadline");
}

// Load the optional released native entry only after admission, never for source-only checks.
async function nativeRelayFactory() {
  const entry = "waffle-relay/node-webtransport";
  const adapter: unknown = await import(entry);
  if (!adapter || typeof adapter !== "object" || !("createNodeWebTransportRelayServer" in adapter)
    || typeof adapter.createNodeWebTransportRelayServer !== "function") throw new Error("Missing released WebTransport relay entry");
  const create = adapter.createNodeWebTransportRelayServer;
  return (options: object) => {
    const relay: unknown = create(options);
    if (!relay || typeof relay !== "object" || !("server" in relay) || !(relay.server instanceof HttpServer)
      || !("close" in relay) || typeof relay.close !== "function" || !("tcp" in relay)
      || !relay.tcp || typeof relay.tcp !== "object" || !("ready" in relay.tcp) || !("active" in relay.tcp)) throw new Error("Invalid released WebTransport relay owner");
    const close = relay.close.bind(relay), tcp = relay.tcp;
    return { server: relay.server, ready: Promise.resolve(tcp.ready), active: () => tcp.active,
      close: async () => { await close(); } };
  };
}
