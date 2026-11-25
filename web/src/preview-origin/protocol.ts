// Names and wire shapes shared by the IDE page, the relay frame, the preview-origin service worker,
// the page shim and the static host. Nothing here touches the DOM, so every realm can import it.
import type { PreviewHostInput, PreviewHostOutput } from "waffle/browser/preview-host";

/** Everything the preview origin serves for itself lives under this directory. */
const PREVIEW_ORIGIN_DIR = "/__bunwasm-preview";
export const SW_PATH = `${PREVIEW_ORIGIN_DIR}/sw.js`;
export const RELAY_PATH = `${PREVIEW_ORIGIN_DIR}/relay.html`;
export const SHIM_PATH = `${PREVIEW_ORIGIN_DIR}/ws.js`;
export const COOKIE_PATH = `${PREVIEW_ORIGIN_DIR}/cookie`;
/** The IDE-origin page that frames a preview for a new tab. */
export const FRAME_PAGE = "preview-frame.html";

const MAX_BODY = 64 * 1024 * 1024;
export const MAX_EXCHANGES = 256;
const MAX_TEXT = 16 * 1024;
const MAX_HEADERS = 1024;

export interface PreviewOriginConfig {
  /** The registrable part every preview host ends with: "sprockt.dev", "localhost:4173". */
  domain: string;
  /** Defaults to https, or http when the domain is a loopback name. */
  scheme?: "https" | "http";
}

const ID_PATTERN = "[a-z2-7]{52}";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Loopback names browsers treat as secure contexts over plain HTTP. */
export function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

function domainHostname(domain: string): string {
  return new URL(`http://${domain}`).hostname;
}

function previewScheme(config: PreviewOriginConfig): "https" | "http" {
  return config.scheme ?? (loopbackHost(domainHostname(config.domain)) ? "http" : "https");
}

/**
 * The stable part of a workspace's preview hostnames: the full SHA-256 of the IDE origin and the
 * workspace's immutable identity, in lowercase base32 (52 characters).
 */
export async function previewOriginId(ideOrigin: string, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ideOrigin}\n${identity}`));
  return base32(new Uint8Array(digest));
}

/** `<scheme>://<id>-<port>-pv.<domain>`: one origin per workspace identity and virtual port. */
export function previewOrigin(config: PreviewOriginConfig, id: string, port: number): string {
  if (!new RegExp(`^${ID_PATTERN}$`).test(id)) throw new TypeError("Invalid preview origin id");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid preview port");
  return new URL(`${previewScheme(config)}://${id}-${port}-pv.${config.domain}`).origin;
}

/** The id and virtual port of a preview host (`Host` header or `URL.host`), or null for any other name. */
export function parsePreviewHost(host: string, domain: string): { id: string; port: number } | null {
  const suffix = `-pv.${domain.toLowerCase()}`;
  const name = host.toLowerCase();
  if (!name.endsWith(suffix)) return null;
  const match = new RegExp(`^(${ID_PATTERN})-(\\d{1,5})$`).exec(name.slice(0, -suffix.length));
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { id: match[1]!, port };
}

/** Whether `origin` is a preview origin of this configuration. */
export function isPreviewOrigin(origin: string, config: PreviewOriginConfig): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return url.protocol === `${previewScheme(config)}:` && parsePreviewHost(url.host, config.domain) !== null;
}

/** The IDE-origin wrapper URL that shows `target` (a preview URL) in a new tab. */
export function previewFrameLink(target: string, base: string, config: PreviewOriginConfig): string {
  const link = new URL(FRAME_PAGE, base);
  link.searchParams.set("preview-origin", `${previewScheme(config)}://${config.domain}`);
  link.searchParams.set("url", target);
  return link.href;
}

/**
 * The configuration a page runs with. A build bakes production's in (`__bunwasmPreviewOrigin`).
 * The `?preview-origin=<domain>` parameter is honored only on a loopback or `.test` IDE host:
 * on a public host it would let a crafted link hand a workspace's dev server to another site.
 */
export function resolvePreviewOriginConfig(location: { hostname: string; port: string; search: string }, built?: unknown): PreviewOriginConfig | null {
  const baked = configFrom(built);
  if (baked) return baked;
  const params = new URLSearchParams(location.search);
  const requested = params.get("preview-origin");
  if (requested === null) return null;
  if (!loopbackHost(location.hostname) && !location.hostname.endsWith(".test")) return null;
  if (requested === "") return { domain: location.port ? `localhost:${location.port}` : "localhost" };
  return configFrom(requested);
}

function configFrom(value: unknown): PreviewOriginConfig | null {
  if (typeof value !== "string" || value === "") return null;
  const match = /^(?:(https?):\/\/)?([a-z0-9.-]+(?::\d{1,5})?)$/i.exec(value);
  if (!match) return null;
  const domain = match[2]!.toLowerCase();
  if (match[1] === "http" || match[1] === "https") return { domain, scheme: match[1] };
  return { domain };
}

/**
 * Environment for dev servers behind preview origins. Waffle forwards a request's public Host
 * name. Vite refuses names it does not know, except loopback ones, and reads further allowed
 * names from this variable, so no template has to list the preview domain.
 */
export function previewHostEnv(config: PreviewOriginConfig | null): Record<string, string> {
  const hostname = config ? domainHostname(config.domain) : "localhost";
  return loopbackHost(hostname) ? {} : { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${hostname}` };
}

/** A cookie as page script may see it. HttpOnly cookies never take this shape. */
export interface ScriptCookie {
  name: string;
  value: string;
  path: string;
  /** Milliseconds since the epoch, or null for a session cookie. */
  expires: number | null;
  secure: boolean;
}

// ---- relay frame <-> IDE page (window.postMessage) ----

export const RELAY_MESSAGE = "bunwasm-preview-relay";
export type RelayEvent = "ready" | "need-port" | "attach";
export interface RelayMessage { type: typeof RELAY_MESSAGE; event: RelayEvent }

export function relayMessage(value: unknown): RelayMessage | null {
  if (!record(value) || value.type !== RELAY_MESSAGE) return null;
  if (value.event !== "ready" && value.event !== "need-port" && value.event !== "attach") return null;
  return { type: RELAY_MESSAGE, event: value.event };
}

// ---- preview page -> its embedder (window.postMessage) ----

export const FRAME_MESSAGE = "bunwasm-preview-frame";
/** `load`: a guest document finished loading. `error`: the service worker answered for the server. */
export interface FrameMessage { type: typeof FRAME_MESSAGE; event: "commit" | "load" | "error"; href: string; title?: string; transient?: boolean }

export function frameMessage(value: unknown): FrameMessage | null {
  if (!record(value) || value.type !== FRAME_MESSAGE || !text(value.href)) return null;
  if (value.event !== "commit" && value.event !== "load" && value.event !== "error") return null;
  return {
    type: FRAME_MESSAGE,
    event: value.event,
    href: value.href,
    title: text(value.title) ? value.title : undefined,
    transient: value.transient === true,
  };
}

// ---- service worker <-> relay frame and preview pages (ServiceWorker.postMessage) ----

export const SW_ATTACH = "bunwasm-preview-attach";
export const SW_NEED_PORT = "bunwasm-preview-need-port";
export const SW_SOCKET = "bunwasm-preview-socket";
export const SW_SHIM = "bunwasm-preview-shim";
export const SW_COOKIES = "bunwasm-preview-cookies";
export const SW_COOKIES_ACK = "bunwasm-preview-cookies-ack";

// ---- service worker <-> IDE page (the attached MessagePort) ----

/** What the preview origin may ask of its one grant. Every field is validated on the IDE side. */
export type SessionRequest =
  | { t: "attached" }
  | { t: "ping"; n: number }
  | { t: "open"; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null; credentials: "omit" | "include" }
  | { t: "input"; id: number; input: PreviewHostInput }
  | { t: "cookie"; id: number; line: string; url: string }
  | { t: "socket" };

export type SessionReply =
  | { t: "pong"; n: number }
  | { t: "cookies"; id?: number; cookies: ScriptCookie[] }
  | { t: "output"; id: number; output: PreviewHostOutput; cookies?: ScriptCookie[] }
  | { t: "finish"; id: number }
  | { t: "detach" };

/** The first message on a socket port, then raw bytes in both directions. */
export type SocketRequest =
  | { type: "open"; url: string; method: string; headers: [string, string][] }
  | { type: "data"; chunk: Uint8Array<ArrayBuffer> }
  | { type: "end" };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function text(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_TEXT; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function token(value: unknown): value is string { return typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(value); }
function pairs(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.length <= MAX_HEADERS && value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(text));
}
function bytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.byteLength <= MAX_BODY;
}

function hostInput(value: unknown): PreviewHostInput | null {
  if (!record(value)) return null;
  if (value.type === "pull") return { type: "pull" };
  if (value.type === "end") return { type: "end" };
  if (value.type === "data" && bytes(value.chunk)) return { type: "data", chunk: value.chunk };
  return null;
}

function openRequest(value: Record<string, unknown>): SessionRequest | null {
  if (!count(value.id) || !text(value.url) || !token(value.method) || !pairs(value.headers)) return null;
  const body = value.body;
  if (body !== null && !(body instanceof ArrayBuffer && body.byteLength <= MAX_BODY)) return null;
  const credentials = value.credentials === "omit" ? "omit" : "include";
  return { t: "open", id: value.id, url: value.url, method: value.method, headers: value.headers, body, credentials };
}

/** A well-formed request from the preview origin, or null. Nothing else reaches Waffle. */
export function sessionRequest(value: unknown): SessionRequest | null {
  if (!record(value)) return null;
  switch (value.t) {
    case "attached": return { t: "attached" };
    case "socket": return { t: "socket" };
    case "ping": return count(value.n) ? { t: "ping", n: value.n } : null;
    case "open": return openRequest(value);
    case "cookie": return count(value.id) && text(value.line) && text(value.url) ? { t: "cookie", id: value.id, line: value.line, url: value.url } : null;
    case "input": {
      const input = hostInput(value.input);
      return count(value.id) && input ? { t: "input", id: value.id, input } : null;
    }
    default: return null;
  }
}

/** A well-formed message on a socket port, or null. */
export function socketRequest(value: unknown): SocketRequest | null {
  if (!record(value)) return null;
  if (value.type === "end") return { type: "end" };
  if (value.type === "data") return bytes(value.chunk) ? { type: "data", chunk: value.chunk } : null;
  if (value.type !== "open" || !text(value.url) || !token(value.method) || !pairs(value.headers)) return null;
  return { type: "open", url: value.url, method: value.method, headers: value.headers };
}
