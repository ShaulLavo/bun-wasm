import type { PreviewHostAuthorization, PreviewHostInput, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";

export const OWNER_PATH = "/__bun_preview_owner";
export const MAX_FRAME = 8 * 1024 * 1024;
export const MAX_BODY = 4 * 1024 * 1024;
export const MAX_EXCHANGES = 64;

// Only the envelope is Bun-owned. Payloads are Waffle's exported exchange types.
export type OwnerFrame =
  | { type: "reserved"; id: string; origin: string; port: number }
  | { type: "bound"; id: string }
  | { type: "open"; id: string; open: PreviewHostOpen }
  | { type: "input"; id: string; input: PreviewHostInput };
export type HostFrame =
  | { type: "register"; id: string; port: number }
  | { type: "grant"; id: string; authorization: PreviewHostAuthorization }
  | { type: "unregister"; id: string }
  | { type: "output"; id: string; output: PreviewHostOutput }
  | { type: "finish"; id: string };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function port(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535; }
function text(value: unknown): value is string { return typeof value === "string" && value.length <= 8192; }
function pairs(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.length <= 1024 && value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(text));
}
function rootOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
function authorization(value: unknown): value is PreviewHostAuthorization {
  return record(value) && identifier(value.owner) && port(value.port) && rootOrigin(value.origin)
    && typeof value.capability === "string" && value.capability.length >= 16 && value.capability.length <= 256;
}
function open(value: unknown): value is PreviewHostOpen {
  if (!record(value) || !authorization(value.authorization) || !text(value.url)) return false;
  const url = new URL(value.url);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.origin !== value.authorization.origin || url.username || url.password) return false;
  if (value.type === "socket") return true;
  return value.type === "http" && /^https?:/.test(value.url) && text(value.method) && pairs(value.headers)
    && (value.body === null || value.body instanceof ArrayBuffer && value.body.byteLength <= MAX_BODY);
}
function input(value: unknown): value is PreviewHostInput {
  if (!record(value)) return false;
  return value.type === "pull" || value.type === "end" || value.type === "data" && value.chunk instanceof Uint8Array && value.chunk.byteLength <= MAX_BODY;
}
function output(value: unknown): value is PreviewHostOutput {
  if (!record(value)) return false;
  if (value.type === "accepted" || value.type === "end") return true;
  if (value.type === "error") return text(value.message);
  if (value.type === "data") return value.chunk instanceof Uint8Array && value.chunk.byteLength <= MAX_BODY;
  return value.type === "head" && typeof value.status === "number" && Number.isInteger(value.status)
    && value.status >= 200 && value.status <= 599 && text(value.statusText) && pairs(value.headers);
}

function bytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decoded(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BODY / 3) * 4) throw new TypeError("Invalid owner bytes");
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export function encode(frame: OwnerFrame | HostFrame): string {
  const result = JSON.stringify(frame, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) return { $buffer: bytes(new Uint8Array(value)) };
    if (value instanceof Uint8Array) return { $bytes: bytes(value) };
    return value;
  });
  if (result.length > MAX_FRAME) throw new Error("Preview owner frame limit");
  return result;
}
function decode(source: string): unknown {
  if (source.length > MAX_FRAME) throw new Error("Preview owner frame limit");
  return JSON.parse(source, (_key, value: unknown) => {
    if (!record(value) || Object.keys(value).length !== 1) return value;
    if ("$buffer" in value) return decoded(value.$buffer).buffer;
    if ("$bytes" in value) return decoded(value.$bytes);
    return value;
  });
}
export function ownerFrame(source: string): OwnerFrame {
  const value = decode(source);
  if (!record(value) || !identifier(value.id)) throw new TypeError("Invalid preview owner envelope");
  if (value.type === "reserved" && rootOrigin(value.origin) && port(value.port)) return { type: value.type, id: value.id, origin: value.origin, port: value.port };
  if (value.type === "bound") return { type: value.type, id: value.id };
  if (value.type === "open" && open(value.open)) return { type: value.type, id: value.id, open: value.open };
  if (value.type === "input" && input(value.input)) return { type: value.type, id: value.id, input: value.input };
  throw new TypeError("Invalid preview owner payload");
}
export function hostFrame(source: string): HostFrame {
  const value = decode(source);
  if (!record(value) || !identifier(value.id)) throw new TypeError("Invalid preview host envelope");
  if (value.type === "register" && port(value.port)) return { type: value.type, id: value.id, port: value.port };
  if (value.type === "grant" && authorization(value.authorization)) return { type: value.type, id: value.id, authorization: value.authorization };
  if (value.type === "unregister" || value.type === "finish") return { type: value.type, id: value.id };
  if (value.type === "output" && output(value.output)) return { type: value.type, id: value.id, output: value.output };
  throw new TypeError("Invalid preview host payload");
}
