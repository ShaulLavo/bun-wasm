import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, TLSSocket, type ConnectionOptions } from "node:tls";

const base = process.env.TEST_SERVER;
if (!base) throw new Error("Missing TEST_SERVER");

const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const manifest = parseManifest(await getJson(`${base}/tls-fixtures`));
const host = new URL(base).hostname;
const common = { host, ca: manifest.ca, servername: manifest.servername };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function port(value: unknown): { port: number } {
  check(isRecord(value) && typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0, "Invalid TLS fixture port");
  return { port: value.port };
}

function parseManifest(value: unknown): Manifest {
  check(isRecord(value), "Invalid TLS fixture manifest");
  check(value.version === 1 && typeof value.servername === "string" && typeof value.ca === "string", "Invalid TLS fixture identity");
  check(typeof value.clientCert === "string" && typeof value.clientKey === "string", "Invalid TLS fixture client identity");
  return {
    version: 1,
    servername: value.servername,
    ca: value.ca,
    clientCert: value.clientCert,
    clientKey: value.clientKey,
    tls12: port(value.tls12),
    tls13: port(value.tls13),
    alpn: port(value.alpn),
    mtls: port(value.mtls),
    observer: port(value.observer),
    starttls: port(value.starttls),
  };
}

type Manifest = {
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

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  check(response.ok, `TLS fixture control failed: ${response.status}`);
  return response.json();
}

type FixtureOptions = ConnectionOptions & { signal?: AbortSignal };

function options(portNumber: number, extra: Partial<FixtureOptions> = {}): FixtureOptions {
  return { ...common, port: portNumber, ...extra };
}

function secure(optionsValue: FixtureOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(optionsValue);
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function close(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
}

async function destroyAndClose(socket: Socket): Promise<void> {
  const closed = close(socket);
  socket.destroy();
  await closed;
}

async function echo(portNumber: number, payload: string, extra: Partial<FixtureOptions> = {}): Promise<TLSSocket> {
  const socket = await secure(options(portNumber, extra));
  const received = new Promise<void>((resolve, reject) => {
    let text = "";
    socket.on("data", bytes => {
      text += Buffer.from(bytes).toString("utf8");
      if (text !== payload) return;
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
  socket.write(payload);
  await received;
  await close(socket);
  return socket;
}

async function rejected(optionsValue: FixtureOptions): Promise<boolean> {
  return new Promise(resolve => {
    const socket = tlsConnect(optionsValue);
    let failed = false;
    socket.once("error", () => { failed = true; });
    socket.once("secureConnect", () => socket.destroy());
    socket.once("close", () => resolve(failed));
  });
}

async function callbackReceiver(): Promise<boolean> {
  let receiver: unknown = null;
  const socket = tlsConnect(options(manifest.tls13.port, {
    checkServerIdentity(this: unknown) {
      receiver = this;
      return undefined;
    },
  }));
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => { socket.end(); resolve(); });
    socket.once("error", reject);
  });
  await close(socket);
  return receiver === undefined;
}

async function callbackError(): Promise<boolean> {
  const socket = tlsConnect(options(manifest.tls13.port, { checkServerIdentity: () => new Error("fixture identity error") }));
  return new Promise(resolve => {
    let failed = false;
    socket.once("error", error => { failed = error instanceof Error && error.message === "fixture identity error"; });
    socket.once("close", () => resolve(failed));
  });
}

async function earlyWrite(): Promise<boolean> {
  const payload = "queued-before-secure";
  const socket = tlsConnect(options(manifest.tls13.port));
  let secureSeen = false;
  let dataBeforeSecure = false;
  const received = new Promise<boolean>((resolve, reject) => {
    let text = "";
    socket.on("data", bytes => {
      if (!secureSeen) dataBeforeSecure = true;
      text += Buffer.from(bytes).toString("utf8");
      if (text !== payload) return;
      socket.end();
      resolve(!dataBeforeSecure);
    });
    socket.once("error", reject);
  });
  socket.once("secureConnect", () => { secureSeen = true; });
  socket.write(payload);
  return received;
}

async function startTls(): Promise<boolean> {
  const raw = netConnect({ host, port: manifest.starttls.port });
  const result = new Promise<boolean>((resolve, reject) => {
    let response = Buffer.alloc(0);
    const upgrade = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length < 1) return;
      raw.removeListener("data", upgrade);
      if (response[0] !== 0x53) { raw.destroy(); reject(new Error("STARTTLS upgrade rejected")); return; }
      const remainder = response.subarray(1);
      if (remainder.length) raw.unshift(remainder);
      const expected = Buffer.from("starttls-payload");
      let echoed = Buffer.alloc(0);
      const secureSocket = new TLSSocket(raw, { ...common });
      const collect = (bytes: Buffer) => {
        echoed = Buffer.concat([echoed, bytes]);
        if (echoed.length < expected.length) return;
        secureSocket.removeListener("data", collect);
        secureSocket.end();
      };
      secureSocket.once("secureConnect", () => secureSocket.write(expected));
      secureSocket.on("data", collect);
      secureSocket.once("close", () => resolve(echoed.length === expected.length && echoed.equals(expected)));
      secureSocket.once("error", reject);
    };
    raw.on("data", upgrade);
    raw.once("error", reject);
    raw.once("connect", () => raw.write(sslRequest));
  });
  return result;
}

async function abortAndDestroy(): Promise<boolean> {
  const controller = new AbortController();
  const socket = tlsConnect(options(manifest.tls13.port, { signal: controller.signal }));
  const closed = close(socket).then(() => true, () => false);
  controller.abort();
  socket.destroy();
  return closed;
}

async function reentrantDestroy(): Promise<boolean> {
  const socket = tlsConnect(options(manifest.tls13.port));
  const closed = close(socket).then(() => true, () => false);
  socket.once("secureConnect", () => socket.destroy());
  return closed;
}

async function halfClose(): Promise<boolean> {
  const socket = await secure(options(manifest.tls13.port));
  const received = new Promise<boolean>((resolve, reject) => {
    socket.once("data", bytes => resolve(Buffer.from(bytes).toString("utf8") === "half-close"));
    socket.once("error", reject);
  });
  socket.end("half-close");
  const result = await received;
  await close(socket);
  return result;
}

async function fixtureState(): Promise<unknown> {
  return getJson(`${base}/tls-fixtures/state`);
}

try {
  const tls12 = await secure(options(manifest.tls12.port, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }));
  check(tls12.getProtocol() === "TLSv1.2", "TLS 1.2 did not negotiate");
  await destroyAndClose(tls12);
  console.log("tls12: TLSv1.2");

  const tls13 = await secure(options(manifest.tls13.port, { minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }));
  check(tls13.getProtocol() === "TLSv1.3", "TLS 1.3 did not negotiate");
  tls13.destroy();
  await close(tls13);
  console.log("tls13: TLSv1.3");

  console.log(`default reject: ${await rejected({ host, port: manifest.observer.port, servername: manifest.servername })}`);
  console.log(`explicit ca: ${Boolean(await echo(manifest.tls13.port, "explicit-ca"))}`);
  console.log(`empty ca replacement: ${await rejected({ host, port: manifest.observer.port, servername: manifest.servername, ca: [] })}`);
  console.log(`hostname reject: ${await rejected(options(manifest.tls13.port, { servername: "wrong.tls.test" }))}`);

  const alpn = await secure(options(manifest.alpn.port, { ALPNProtocols: ["fixture/1", "fixture/2"] }));
  const selectedAlpn = alpn.alpnProtocol;
  alpn.destroy();
  await close(alpn);
  console.log(`alpn: ${selectedAlpn}`);

  const peer = await secure(options(manifest.tls13.port));
  const certificate = peer.getPeerCertificate(true);
  const x509 = peer.getPeerX509Certificate();
  const metadata = peer.encrypted && peer.authorized && peer.servername === manifest.servername && peer.getProtocol() === "TLSv1.3" && typeof peer.getCipher()?.name === "string" && typeof certificate.subject === "object" && x509 !== undefined && x509.raw.length > 0;
  await destroyAndClose(peer);
  console.log(`peer metadata: ${metadata}`);

  const client = await secure(options(manifest.mtls.port, { cert: manifest.clientCert, key: manifest.clientKey }));
  const clientAuthorized = client.authorized;
  await destroyAndClose(client);
  console.log(`client identity: ${clientAuthorized}`);

  console.log(`identity receiver: ${await callbackReceiver()}`);
  console.log(`identity error: ${await callbackError()}`);
  console.log(`early write barrier: ${await earlyWrite()}`);
  console.log(`starttls one connection: ${await startTls()}`);
  console.log(`abort destroy: ${await abortAndDestroy()}`);
  console.log(`reentrant destroy: ${await reentrantDestroy()}`);
  console.log(`half close: ${await halfClose()}`);

  let unsupported = false;
  try { Reflect.apply(tlsConnect, undefined, [{ socket: new PassThrough() }]); } catch (error) { unsupported = error instanceof Error && "code" in error && error.code === "ERR_TLS_NOT_SUPPORTED"; }
  console.log(`generic duplex unsupported: ${unsupported}`);

  const after = await fixtureState();
  check(isRecord(after), "Invalid TLS fixture state");
  check(isRecord(after) && after.observerArmed === true && after.observerPlaintextBytes === 0, "TLS observer recorded rejected application bytes");
  const starttlsState = isRecord(after) ? after.starttls : undefined;
  check(isRecord(starttlsState) && starttlsState.connections === 1 && starttlsState.startTlsConnections === 1, "STARTTLS used more than one TCP connection");
  console.log("negative observer: armed and zero plaintext");
} finally {
  await fetch(`${base}/tls-fixtures/close`, { method: "POST" });
}
