import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { createSecureContext, createServer as createTlsServer, connect as tlsConnect, TLSSocket, type Server as TlsServer } from "node:tls";

const execute = promisify(execFile);
const fixturePath = "/tls-fixtures";
const tlsName = "fixture.tls.test";
const observerControl = "TLS_FIXTURE_OBSERVER_CONTROL";
const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

type Version = "TLSv1.2" | "TLSv1.3";
type CloseableServer = NetServer | TlsServer;

type Material = {
  ca: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
};

type Endpoint = {
  port: number;
  connections: number;
  secureConnections: number;
  applicationBytes: number;
  liveSockets: Set<Socket>;
};

type ObserverEndpoint = Endpoint & {
  observerBytes: number;
  observerArmed: boolean;
};

type StartTlsEndpoint = Endpoint & {
  startTlsConnections: number;
};

type FixtureManifest = {
  version: 1;
  servername: string;
  ca: string;
  clientCert: string;
  clientKey: string;
  tls12: { port: number };
  tls13: { port: number };
  alpn: { port: number };
  mtls: { port: number };
  observer: { port: number };
  starttls: { port: number };
};

type FixtureState = {
  closed: boolean;
  observerArmed: boolean;
  observerPlaintextBytes: number;
  tls12: EndpointState;
  tls13: EndpointState;
  alpn: EndpointState;
  mtls: EndpointState;
  observer: EndpointState;
  starttls: EndpointState & { startTlsConnections: number };
};

type EndpointState = {
  port: number;
  connections: number;
  secureConnections: number;
  applicationBytes: number;
  liveSockets: number;
};

type Resource = {
  server: CloseableServer;
  sockets: Set<Socket>;
};

type FixtureBatch = {
  manifest: FixtureManifest;
  state(): FixtureState;
  close(): Promise<void>;
};

export function isTlsFixturePath(pathname: string): boolean {
  return pathname === fixturePath || pathname.startsWith(`${fixturePath}/`);
}

export async function handleTlsFixtureRequest(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!isTlsFixturePath(url.pathname)) return undefined;
  if (request.method === "GET" && url.pathname === fixturePath) return Response.json(await ensureBatch().then(batch => batch.manifest));
  if (request.method === "GET" && url.pathname === `${fixturePath}/state`) return Response.json(await ensureBatch().then(batch => batch.state()));
  if ((request.method === "POST" || request.method === "GET") && url.pathname === `${fixturePath}/close`) return Response.json(await closeBatch());
  return new Response("not found", { status: 404 });
}

let batchPromise: Promise<FixtureBatch> | undefined;

async function ensureBatch(): Promise<FixtureBatch> {
  if (batchPromise) return batchPromise;
  const pending = createBatch();
  batchPromise = pending.catch(error => {
    batchPromise = undefined;
    throw error;
  });
  return batchPromise;
}

async function closeBatch(): Promise<FixtureState | { closed: true }> {
  const pending = batchPromise;
  if (!pending) return { closed: true };
  const batch = await pending;
  await batch.close();
  batchPromise = undefined;
  return batch.state();
}

async function createBatch(): Promise<FixtureBatch> {
  const scratch = await makeScratch();
  const resources: Resource[] = [];
  const endpoints = createEndpoints();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let removeSignals: (() => void) | undefined;
  try {
    const material = await createMaterial(scratch);
    const context = createSecureContext({ key: material.serverKey, cert: material.serverCert });
    resources.push(await startTlsEndpoint(endpoints.tls12, material, "TLSv1.2"));
    resources.push(await startTlsEndpoint(endpoints.tls13, material, "TLSv1.3"));
    resources.push(await startTlsEndpoint(endpoints.alpn, material, "TLSv1.3", ["fixture/2", "fixture/1"]));
    resources.push(await startTlsEndpoint(endpoints.mtls, material, "TLSv1.3", undefined, true));
    resources.push(await startObserver(endpoints.observer, material));
    resources.push(await startStartTls(endpoints.starttls, material, context));
    await armObserver(endpoints.observer, material.ca);
    const manifest: FixtureManifest = {
      version: 1,
      servername: tlsName,
      ca: material.ca,
      clientCert: material.clientCert,
      clientKey: material.clientKey,
      tls12: { port: endpoints.tls12.port },
      tls13: { port: endpoints.tls13.port },
      alpn: { port: endpoints.alpn.port },
      mtls: { port: endpoints.mtls.port },
      observer: { port: endpoints.observer.port },
      starttls: { port: endpoints.starttls.port },
    };
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      for (const resource of resources.toReversed()) await closeResource(resource);
      await rm(scratch, { recursive: true, force: true });
      removeSignals?.();
      removeSignals = undefined;
    };
    const close = () => {
      if (!closePromise) closePromise = cleanup();
      return closePromise;
    };
    removeSignals = installSignalCleanup(close);
    return { manifest, state: () => stateOf(closed, endpoints), close };
  } catch (error) {
    for (const resource of resources.toReversed()) await closeResource(resource);
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

async function makeScratch(): Promise<string> {
  const base = process.env.TMPDIR ?? tmpdir();
  return mkdtemp(join(base, "bun-wasm-tls-fixtures-"));
}

function createEndpoints(): {
  tls12: Endpoint;
  tls13: Endpoint;
  alpn: Endpoint;
  mtls: Endpoint;
  observer: ObserverEndpoint;
  starttls: StartTlsEndpoint;
} {
  return {
    tls12: endpoint(),
    tls13: endpoint(),
    alpn: endpoint(),
    mtls: endpoint(),
    observer: { ...endpoint(), observerBytes: 0, observerArmed: false },
    starttls: { ...endpoint(), startTlsConnections: 0 },
  };
}

function endpoint(): Endpoint {
  return { port: 0, connections: 0, secureConnections: 0, applicationBytes: 0, liveSockets: new Set() };
}

async function createMaterial(root: string): Promise<Material> {
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=bun-wasm fixture CA", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], commandOptions(root));
  await createLeaf(root, "server", "serverAuth", `DNS:${tlsName},DNS:localhost,IP:127.0.0.1`);
  await createLeaf(root, "client", "clientAuth", "DNS:fixture-client.tls.test");
  await chmod(join(root, "ca.key"), 0o600);
  await chmod(join(root, "server.key"), 0o600);
  await chmod(join(root, "client.key"), 0o600);
  return {
    ca: await readFile(join(root, "ca.pem"), "utf8"),
    serverCert: await readFile(join(root, "server.pem"), "utf8"),
    serverKey: await readFile(join(root, "server.key"), "utf8"),
    clientCert: await readFile(join(root, "client.pem"), "utf8"),
    clientKey: await readFile(join(root, "client.key"), "utf8"),
  };
}

async function createLeaf(root: string, name: string, usage: string, san: string): Promise<void> {
  await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}.${tlsName}`], commandOptions(root));
  await writeFile(join(root, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n`);
  await execute("openssl", ["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-sha256", "-extfile", `${name}.ext`], commandOptions(root));
}

function commandOptions(cwd: string): { cwd: string; timeout: number; maxBuffer: number } {
  return { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 };
}

async function startTlsEndpoint(endpoint: Endpoint, material: Material, version: Version, alpn?: string[], requestCert = false): Promise<Resource> {
  const options = {
    key: material.serverKey,
    cert: material.serverCert,
    ca: material.ca,
    minVersion: version,
    maxVersion: version,
    requestCert,
    rejectUnauthorized: requestCert,
    ...(alpn === undefined ? {} : { ALPNProtocols: alpn }),
  };
  const server = createTlsServer(options, socket => handleEcho(socket, endpoint));
  return startResource(server, endpoint);
}

async function startObserver(endpoint: ObserverEndpoint, material: Material): Promise<Resource> {
  const server = createTlsServer({ key: material.serverKey, cert: material.serverCert, ca: material.ca, requestCert: false, rejectUnauthorized: false }, socket => {
    endpoint.secureConnections++;
    socket.on("data", bytes => { endpoint.observerBytes += bytes.length; endpoint.applicationBytes += bytes.length; socket.write(bytes); });
    socket.on("end", () => socket.end());
    socket.on("error", () => socket.destroy());
  });
  return startResource(server, endpoint);
}

async function startStartTls(endpoint: StartTlsEndpoint, material: Material, context: ReturnType<typeof createSecureContext>): Promise<Resource> {
  const server = createServer(socket => {
    socket.once("error", () => socket.destroy());
    let request = Buffer.alloc(0);
    const upgrade = (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      if (request.length < sslRequest.length) return;
      socket.removeListener("data", upgrade);
      if (!request.subarray(0, sslRequest.length).equals(sslRequest)) {
        endpoint.applicationBytes += request.length;
        socket.destroy();
        return;
      }
      endpoint.startTlsConnections++;
      const remainder = request.subarray(sslRequest.length);
      if (remainder.length) socket.unshift(remainder);
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
      secure.on("data", bytes => { endpoint.applicationBytes += bytes.length; secure.write(bytes); });
      secure.on("end", () => secure.end());
      secure.on("error", () => secure.destroy());
    };
    socket.on("data", upgrade);
  });
  return startResource(server, endpoint);
}

async function startResource(server: CloseableServer, endpoint: Endpoint): Promise<Resource> {
  const sockets = new Set<Socket>();
  server.on("connection", socket => trackSocket(socket, sockets, endpoint));
  endpoint.port = await listen(server);
  return { server, sockets };
}

function trackSocket(socket: Socket, sockets: Set<Socket>, endpoint: Endpoint): void {
  endpoint.connections++;
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
}

function handleEcho(socket: TLSSocket, endpoint: Endpoint): void {
  endpoint.secureConnections++;
  socket.on("data", bytes => { endpoint.applicationBytes += bytes.length; socket.write(bytes); });
  socket.on("end", () => socket.end());
  socket.on("error", () => socket.destroy());
}

async function listen(server: CloseableServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { server.removeListener("error", fail); reject(error); };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("TLS fixture server has no address")); return; }
      resolve(address.port);
    });
  });
}

async function closeResource(resource: Resource): Promise<void> {
  for (const socket of resource.sockets) socket.destroy();
  await closeServer(resource.server);
}

async function closeServer(server: CloseableServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function armObserver(endpoint: ObserverEndpoint, ca: string): Promise<void> {
  const socket = tlsConnect({ host: "127.0.0.1", port: endpoint.port, ca, servername: tlsName });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("secureConnect", () => socket.end(observerControl));
      socket.once("close", () => resolve());
    });
    if (endpoint.observerBytes !== Buffer.byteLength(observerControl)) throw new Error("TLS fixture observer did not arm");
    endpoint.observerArmed = true;
    endpoint.observerBytes = 0;
  } finally {
    socket.destroy();
  }
}

function stateOf(closed: boolean, endpoints: ReturnType<typeof createEndpoints>): FixtureState {
  return {
    closed,
    observerArmed: endpoints.observer.observerArmed,
    observerPlaintextBytes: endpoints.observer.observerBytes,
    tls12: stateOfEndpoint(endpoints.tls12),
    tls13: stateOfEndpoint(endpoints.tls13),
    alpn: stateOfEndpoint(endpoints.alpn),
    mtls: stateOfEndpoint(endpoints.mtls),
    observer: stateOfEndpoint(endpoints.observer),
    starttls: { ...stateOfEndpoint(endpoints.starttls), startTlsConnections: endpoints.starttls.startTlsConnections },
  };
}

function stateOfEndpoint(endpoint: Endpoint): EndpointState {
  return { port: endpoint.port, connections: endpoint.connections, secureConnections: endpoint.secureConnections, applicationBytes: endpoint.applicationBytes, liveSockets: endpoint.liveSockets.size };
}

function installSignalCleanup(close: () => Promise<void>): () => void {
  const stop = () => { void close().catch(() => {}); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  return () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  };
}
