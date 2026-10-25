import type { Route } from "playwright";
import { recorderErrorHeader } from "./registry.mjs";
import { decodedResponse } from "./decoded-response";

export function registryAccept(path: string): string {
  return path === "/-/package/next/dist-tags" ? "application/json" : "application/vnd.npm.install-v1+json";
}

export function registryReplayUrl(url: string, registry: string): string | null {
  if (url !== "https://registry.npmjs.org/-/package/next/dist-tags") return null;
  return `${registry}/-/package/next/dist-tags`;
}

type BrowserRegistryRoute = Pick<Route, "fetch" | "fulfill" | "continue" | "abort"> & {
  request(): Pick<ReturnType<Route["request"]>, "url" | "method" | "headers">;
};

export async function browserRegistryRoute(route: BrowserRegistryRoute, registry: string, external: string[]): Promise<void> {
  const url = new URL(route.request().url());
  if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  const replay = registryReplayUrl(url.href, registry);
  if (replay && route.request().method() === "GET") {
    const response = await route.fetch({ url: replay, maxRedirects: 0 });
    if (response.ok()) return route.fulfill({ response });
  }
  external.push(url.href);
  return route.abort();
}

export async function registryBrokerResponse(request: Request): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const url = new URL(path, "https://registry.npmjs.org");
    if (url.origin !== "https://registry.npmjs.org") throw new Error("Invalid recorder origin");
    const upstream = await fetch(url, { headers: { accept: registryAccept(path) }, redirect: "error", signal: AbortSignal.timeout(60000) });
    return await decodedResponse(upstream);
  } catch (error) { return new Response(String(error), { status: 502, headers: { [recorderErrorHeader]: "1" } }); }
}
