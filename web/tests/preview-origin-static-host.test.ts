import { expect, test } from "bun:test";
import { previewOriginAssets } from "../preview-origin-build";
import { handlePreviewOriginRequest, IDE_ORIGINS_PLACEHOLDER, type PreviewOriginHostConfig } from "../src/preview-origin/host";
import { RELAY_PATH, SW_PATH } from "../src/preview-origin/protocol";

const HOST = `${"a".repeat(52)}-5173-pv.sprockt.dev`;
const config: PreviewOriginHostConfig = {
  domain: "sprockt.dev",
  ideOrigins: ["https://bun.sprockt.dev", "https://sprockt.dev"],
  asset: name => `asset:${name}${name === "relay.html" ? ` origins=${IDE_ORIGINS_PLACEHOLDER};` : ""}`,
};
const get = (url: string, headers: Record<string, string> = {}, method = "GET") => handlePreviewOriginRequest(new Request(url, { method, headers }), config);

test("any other host is not this handler's to answer", () => {
  for (const url of ["https://bun.sprockt.dev/", "https://sprockt.dev/__bunwasm-preview/sw.js", "https://www-pv.sprockt.dev/", `https://${HOST}.evil.dev/`]) expect(get(url)).toBeNull();
});

test("the worker script is served for the whole origin with the allowed IDE origins in front", async () => {
  const response = await get(`https://${HOST}${SW_PATH}`)!;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/javascript");
  expect(response.headers.get("service-worker-allowed")).toBe("/");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(await response.text()).toBe('self.__bunwasmPreviewIdeOrigins=["https://bun.sprockt.dev","https://sprockt.dev"];\nasset:sw.js');
});

test("the relay page names the IDE origins and only they may frame it", async () => {
  const response = await get(`https://${HOST}${RELAY_PATH}`)!;
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors https://bun.sprockt.dev https://sprockt.dev");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(await response.text()).toBe('asset:relay.html origins=["https://bun.sprockt.dev","https://sprockt.dev"];');
});

test("a framed navigation boots the worker, a top-level one is told to use the IDE, and nothing else is answered", async () => {
  const framed = await get(`https://${HOST}/dashboard?x=1`, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" })!;
  expect(await framed.text()).toBe("asset:bootstrap.html");
  expect(framed.headers.get("content-security-policy")).toStartWith("frame-ancestors https://bun.sprockt.dev");
  const top = await get(`https://${HOST}/`, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })!;
  expect(await top.text()).toBe("asset:top.html");
  const legacy = await get(`https://${HOST}/`, { accept: "text/html,application/xhtml+xml" })!;
  expect(await legacy.text()).toBe("asset:bootstrap.html");
  const asset = await get(`https://${HOST}/assets/app.js`, { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" })!;
  expect(asset.status).toBe(503);
  expect(asset.headers.get("cache-control")).toBe("no-store");
  const post = await get(`https://${HOST}/api`, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, "POST")!;
  expect(post.status).toBe(503);
  const head = await get(`https://${HOST}${SW_PATH}`, {}, "HEAD")!;
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("with no IDE origin configured nothing may frame a preview page", async () => {
  const response = await handlePreviewOriginRequest(new Request(`https://${HOST}${RELAY_PATH}`), { ...config, ideOrigins: [] })!;
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
});

test("the built files carry the worker, the shim inside it, and one placeholder for the IDE origins", async () => {
  const assets = await previewOriginAssets();
  expect(Object.keys(assets).sort()).toEqual(["bootstrap.html", "relay.html", "sw.js", "top.html"]);
  expect(assets["sw.js"]).toContain("bunwasm-preview-attach");
  // The page shim travels inside the worker, which serves it at /__bunwasm-preview/ws.js.
  expect(assets["sw.js"]).toContain("bunwasm-preview-frame");
  expect(assets["relay.html"].split(IDE_ORIGINS_PLACEHOLDER).length).toBe(2);
  expect(assets["bootstrap.html"]).toContain("serviceWorker");
  expect(assets["top.html"]).toContain("only works inside its IDE tab");
  expect(assets["top.html"]).not.toContain("<script");
}, 60_000);
