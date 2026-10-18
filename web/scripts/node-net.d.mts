import type { EngineNet } from "../src/net/host.ts";

export function createNodeNet(options: {
  net: typeof import("node:net");
  http: typeof import("node:http");
  https: typeof import("node:https");
  zlib: typeof import("node:zlib");
}): EngineNet & {
  natives: {
    hostConnect(host: string, port: number): number;
    hostWrite(handle: number, bytes: Uint8Array): number;
    hostClose(handle: number): number;
  };
};
