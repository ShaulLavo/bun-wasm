import type { EngineNet } from "../src/net/host.ts";

export function createNodeNet(options: {
  net: typeof import("node:net");
  http: typeof import("node:http");
  https: typeof import("node:https");
  zlib: typeof import("node:zlib");
}): EngineNet;
