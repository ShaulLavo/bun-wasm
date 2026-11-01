import type { BunWasmAsset } from "../../../../src/assets";
import type { Engine } from "../../../src/bun-executor";

export interface C1PageConfig {
  readonly asset: BunWasmAsset;
  readonly engine: Engine;
  readonly endpoint: string;
  readonly preview1: { readonly target: { readonly host: string; readonly port: number }; readonly expectedStdout: string };
}
export const modes = ["automatic", "websocket", "no-relay"] as const;
export type C1Mode = typeof modes[number];
export type C1Carrier = "webtransport" | "websocket";

export function localhostOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) throw new Error("C1 requires exact http://127.0.0.1:<port>/ on the execution host");
  return url.origin;
}

export function assertCarrier(mode: C1Mode, observed: readonly C1Carrier[], expectedOpens: number): void {
  if (mode === "no-relay") {
    if (observed.length) throw new Error("No-relay run activated a relay");
    return;
  }
  if (observed.length !== expectedOpens) throw new Error("Missing completed relay open carrier observations");
  if (mode === "websocket" && observed.some(carrier => carrier !== "websocket")) throw new Error("Forced WebSocket selected another carrier");
}

/** A database credential is guest configuration. Relay authorization never belongs here. */
export function databaseEnvironment(value: unknown): { PGPASSWORD: string } {
  if (!value || typeof value !== "object" || !("PGPASSWORD" in value)
    || typeof value.PGPASSWORD !== "string" || !value.PGPASSWORD.length) throw new Error("C1 database password was not forwarded");
  return { PGPASSWORD: value.PGPASSWORD };
}

export const publicTopology = {
  pageOrigin: "https://waffle-network.sprockt.dev",
  relayEndpoint: "https://waffle-relay-public.sprockt.dev/",
} as const;

export function requireLocalTopology(value: string | undefined): void {
  if (value === undefined || value === "localhost") return;
  if (value === "public") throw new Error("C1 public mode is blocked pending the network owner's qualified Brine relay, exact demo Origin and signing/token handoff");
  throw new Error("C1_TOPOLOGY must be localhost or public");
}
