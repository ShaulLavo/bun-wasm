import type { Route } from "playwright";
import { recorderErrorHeader } from "./registry.mjs";
import { decodedResponse } from "./decoded-response.ts";

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
  if ((["localhost", "[::1]"].includes(url.hostname) || /^127\.(?:[0-9]+\.){2}[0-9]+$/.test(url.hostname)) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  const replay = registryReplayUrl(url.href, registry);
  if (replay && route.request().method() === "GET" && await fulfillRegistryReplay(route, replay)) return;
  external.push(url.href);
  return route.abort();
}

async function fulfillRegistryReplay(route: BrowserRegistryRoute, url: string): Promise<boolean> {
  try {
    const headers = { ...route.request().headers(), accept: "application/json" };
    const response = await route.fetch({ url, method: "GET", headers, maxRedirects: 0 });
    if (!response.ok()) return false;
    await route.fulfill({ response });
    return true;
  } catch { return false; }
}

export async function registryBrokerResponse(request: Request): Promise<Response> {
  try {
    const requested = new URL(request.url);
    if (requested.search) throw new Error("Recorder query strings are unsupported");
    const path = requested.pathname;
    const url = new URL(path, "https://registry.npmjs.org");
    if (url.origin !== "https://registry.npmjs.org") throw new Error("Invalid recorder origin");
    const upstream = await fetch(url, { headers: { accept: registryAccept(path) }, redirect: "error", signal: AbortSignal.timeout(60000) });
    return await decodedResponse(upstream);
  } catch (error) { return new Response(String(error), { status: 502, headers: { [recorderErrorHeader]: "1" } }); }
}
