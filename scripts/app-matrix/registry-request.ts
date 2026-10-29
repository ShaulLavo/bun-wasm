import type { Route } from "playwright";
import { recorderErrorHeader } from "./registry.mjs";
import { decodedResponse } from "./decoded-response.ts";
import { advisoryBodyLimit, advisoryPath, advisoryResponseLimit, boundedRegistryBody, registryIdentity } from "./registry-identity";

export function registryAccept(path: string): string {
  return (path === "/-/package/next/dist-tags" || path === advisoryPath) ? "application/json" : "application/vnd.npm.install-v1+json";
}

export function registryReplayUrl(url: string, registry: string): string | null {
  if (!["https://registry.npmjs.org/-/package/next/dist-tags", `https://registry.npmjs.org${advisoryPath}`].includes(url)) return null;
  return `${registry}${new URL(url).pathname}`;
}

type BrowserRegistryRoute = Pick<Route, "fetch" | "fulfill" | "continue" | "abort"> & {
  request(): Pick<ReturnType<Route["request"]>, "url" | "method" | "headers" | "postDataBuffer">;
};

export async function browserRegistryRoute(route: BrowserRegistryRoute, registry: string, external: string[]): Promise<void> {
  const url = new URL(route.request().url());
  if ((["localhost", "[::1]"].includes(url.hostname) || /^127\.(?:[0-9]+\.){2}[0-9]+$/.test(url.hostname)) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
  const replay = registryReplayUrl(url.href, registry);
  const method = route.request().method();
  const advisory = url.pathname === advisoryPath;
  if (replay && (advisory ? method === "POST" : method === "GET") && await fulfillRegistryReplay(route, replay)) return;
  external.push(url.href);
  return route.abort();
}

async function fulfillRegistryReplay(route: BrowserRegistryRoute, url: string): Promise<boolean> {
  try {
    const request = route.request();
    const body = request.postDataBuffer();
    if (body && body.length > advisoryBodyLimit) return false;
    const advisory = new URL(url).pathname === advisoryPath;
    const headers: Record<string, string> = advisory ? { accept: "application/json", "content-type": "application/json" } : { ...request.headers(), accept: "application/json" };
    const response = await route.fetch({ url, method: request.method(), headers, postData: body ?? undefined, maxRedirects: 0 });
    if (response.headers()[recorderErrorHeader] || (!advisory && !response.ok())) return false;
    await route.fulfill({ response });
    return true;
  } catch { return false; }
}

export async function registryBrokerResponse(request: Request): Promise<Response> {
  try {
    const identity = await registryIdentity(request);
    const url = new URL(identity.path, "https://registry.npmjs.org");
    if (url.origin !== "https://registry.npmjs.org") throw new Error("Invalid recorder origin");
    const headers: Record<string, string> = { accept: registryAccept(identity.path) };
    if (identity.method === "POST") headers["content-type"] = "application/json";
    const upstream = await fetch(url, { method: identity.method, body: identity.body, headers, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (identity.method === "POST") {
      const bytes = await boundedRegistryBody(upstream, advisoryResponseLimit);
      return new Response(bytes, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
    }
    return await decodedResponse(upstream);
  } catch (error) { return new Response(String(error), { status: 502, headers: { [recorderErrorHeader]: "1" } }); }
}
