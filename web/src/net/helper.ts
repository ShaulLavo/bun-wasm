// Bun's network policy adapter. Generic I/O and ring handling belong to the runtime;
// only Bun's installer download cache is selected here.
import { NetHelper as RuntimeNetHelper, type NetNamespace, type NetHelperHooks } from "waffle/browser/net/helper";
import type { NetConnect } from "waffle/browser/net/outbound";
import { installFetch } from "./install-cache.js";

export type { ConnectionSink, NetFetch, NetHelperHooks, PreviewConnection, PreviewSink } from "waffle/browser/net/helper";

export class NetHelper extends RuntimeNetHelper {
  constructor(sab: SharedArrayBuffer, namespace: NetNamespace, hooks: NetHelperHooks = {}) {
    super(sab, installFetch, hooks, namespace);
  }
}

export type { RuntimeNetworkHelper } from "waffle";
import type { RuntimeNetwork, RuntimeNetworkHelper } from "waffle";
import type { NetFetch } from "waffle/browser/net/helper";
import type { NetRequest } from "waffle/browser/net/protocol";

export interface BunRelayOptions {
  readonly endpoint: string | URL;
  readonly getToken: () => string | Promise<string>;
  readonly carriers?: readonly ("webtransport" | "websocket")[];
  readonly windowBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly onCarrier?: (carrier: "webtransport" | "websocket") => void;
}

export interface BunNetworkOptions {
  readonly fetch?: NetFetch;
  readonly relay?: BunRelayOptions;
  readonly connect?: NetConnect;
  readonly pathScope?: Parameters<RuntimeNetwork["createHelper"]>[0]["pathScope"];
  listening?(port: number, helper: RuntimeNetworkHelper): void;
  stopped?(port: number, helper: RuntimeNetworkHelper): void;
}

export function createBunNetworkHelper(
  network: RuntimeNetwork,
  ring: SharedArrayBuffer,
  options: BunNetworkOptions = {},
): RuntimeNetworkHelper {
  const fetch = options.fetch ?? installFetch;
  const listening = options.listening;
  const stopped = options.stopped;
  const helper = network.createHelper({ ring, fetch, connect: options.connect, pathScope: options.pathScope, hooks: {
    listening: port => listening?.(port, helper),
    stopped: port => stopped?.(port, helper),
  } });
  return helper;
}

function isNetRequest(value: unknown): value is NetRequest {
  if (!value || typeof value !== "object" || !("type" in value) || !("id" in value)) return false;
  if (!Number.isSafeInteger(value.id) || typeof value.id !== "number" || value.id < 1) return false;
  switch (value.type) {
    case "unix-listen": return validPath(value) && "unlinkOnClose" in value && typeof value.unlinkOnClose === "boolean" && validReply(value);
    case "unix-connect": return validPath(value) && validReply(value);
    case "unix-close": return validReply(value);
    case "tcp-listen":
      return "host" in value && typeof value.host === "string" && validPort(value) && validReply(value);
    case "tcp-connect": return validPort(value) && validReply(value);
    case "tcp-write": return validReply(value) && "data" in value && value.data instanceof Uint8Array;
    case "listen": return "host" in value && typeof value.host === "string" && validPort(value);
    case "write": return "data" in value && value.data instanceof Uint8Array;
    case "tcp-accept": return "listener" in value && Number.isSafeInteger(value.listener);
    case "ack":
    case "tcp-read": return "bytes" in value && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
    case "close":
    case "shutdown": return true;
    case "fetch": return validFetch(value);
    case "lookup": return validLookup(value);
    default: return false;
  }
}
const validPath = (value: object): boolean => "path" in value && typeof value.path === "string";
const validPort = (value: object): boolean => "port" in value && typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535;
const validReply = (value: object): boolean => "reply" in value && value.reply instanceof SharedArrayBuffer && value.reply.byteLength === 12;
function validLookup(value: object): boolean {
  if (!("hostname" in value) || typeof value.hostname !== "string" || !("options" in value)) return false;
  const options = value.options;
  if (!options || typeof options !== "object") return false;
  const family = "family" in options ? options.family : undefined;
  const hints = "hints" in options ? options.hints : undefined;
  return (family === undefined || family === 0 || family === 4 || family === 6)
    && (hints === undefined || typeof hints === "number" && Number.isSafeInteger(hints));
}
function validFetch(value: object): boolean {
  if (!("method" in value) || typeof value.method !== "string" || !("url" in value) || typeof value.url !== "string") return false;
  if (!("body" in value) || value.body !== null && !(value.body instanceof Uint8Array)) return false;
  if (!("redirect" in value) || typeof value.redirect !== "string" || !["error", "follow", "manual"].includes(value.redirect)) return false;
  return "headers" in value && Array.isArray(value.headers) && value.headers.every(header => Array.isArray(header) && header.length === 2 && header.every(part => typeof part === "string"));
}

export function dispatchBunNetwork(helper: RuntimeNetworkHelper, message: unknown): void {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "net") return;
  if (!("req" in message) || !isNetRequest(message.req)) throw new TypeError("Invalid Bun network request");
  helper.handle(message.req);
}
