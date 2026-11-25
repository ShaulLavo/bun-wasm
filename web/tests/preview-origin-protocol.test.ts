import { expect, test } from "bun:test";
import {
  frameMessage, isPreviewOrigin, parsePreviewHost, previewFrameLink, previewHostEnv, previewOrigin, previewOriginId, relayMessage,
  resolvePreviewOriginConfig, sessionRequest, socketRequest,
} from "../src/preview-origin/protocol";

const ID = "a".repeat(52);

test("an origin id is the full SHA-256 of the IDE origin and the workspace identity, in base32", async () => {
  const id = await previewOriginId("https://bun.sprockt.dev", "workspace-1");
  expect(id).toMatch(/^[a-z2-7]{52}$/);
  expect(await previewOriginId("https://bun.sprockt.dev", "workspace-1")).toBe(id);
  expect(await previewOriginId("https://bun.sprockt.dev", "workspace-2")).not.toBe(id);
  expect(await previewOriginId("https://sprockt.dev", "workspace-1")).not.toBe(id);
  // The longest name still fits one DNS label.
  expect(`${id}-65535-pv`.length).toBeLessThanOrEqual(63);
});

test("preview origins are single-level names that parse back to their id and port", () => {
  expect(previewOrigin({ domain: "sprockt.dev" }, ID, 5173)).toBe(`https://${ID}-5173-pv.sprockt.dev`);
  expect(previewOrigin({ domain: "localhost:4173" }, ID, 3000)).toBe(`http://${ID}-3000-pv.localhost:4173`);
  expect(previewOrigin({ domain: "bunwasm.localhost:4173" }, ID, 3000)).toBe(`http://${ID}-3000-pv.bunwasm.localhost:4173`);
  expect(previewOrigin({ domain: "example.test:8443", scheme: "http" }, ID, 80)).toBe(`http://${ID}-80-pv.example.test:8443`);
  expect(parsePreviewHost(`${ID}-5173-pv.sprockt.dev`, "sprockt.dev")).toEqual({ id: ID, port: 5173 });
  expect(parsePreviewHost(`${ID}-3000-pv.localhost:4173`, "localhost:4173")).toEqual({ id: ID, port: 3000 });
  expect(() => previewOrigin({ domain: "sprockt.dev" }, "short", 5173)).toThrow();
  expect(() => previewOrigin({ domain: "sprockt.dev" }, ID, 70000)).toThrow();
});

test("only the exact preview name shape is a preview host", () => {
  for (const host of [
    "bun.sprockt.dev", "sprockt.dev", "www-pv.sprockt.dev", `${ID}-pv.sprockt.dev`, `${ID}-0-pv.sprockt.dev`, `${ID}-70000-pv.sprockt.dev`,
    `${ID}-5173-pv.evil.dev`, `${ID}-5173-pv.sprockt.dev.evil.dev`, `x.${ID}-5173-pv.sprockt.dev`, `${ID.slice(1)}-5173-pv.sprockt.dev`,
    `${"A".repeat(51)}1-5173-pv.sprockt.dev`, `${ID}-5173-pvsprockt.dev`,
  ]) expect(parsePreviewHost(host, "sprockt.dev")).toBeNull();
  expect(isPreviewOrigin(`https://${ID}-5173-pv.sprockt.dev`, { domain: "sprockt.dev" })).toBe(true);
  expect(isPreviewOrigin(`http://${ID}-5173-pv.sprockt.dev`, { domain: "sprockt.dev" })).toBe(false);
  expect(isPreviewOrigin("https://bun.sprockt.dev", { domain: "sprockt.dev" })).toBe(false);
  expect(isPreviewOrigin("not a url", { domain: "sprockt.dev" })).toBe(false);
});

test("a build's domain wins, and the query parameter works only on a loopback or .test IDE host", () => {
  const local = { hostname: "localhost", port: "4173", search: "?preview-origin" };
  expect(resolvePreviewOriginConfig(local)).toEqual({ domain: "localhost:4173" });
  expect(resolvePreviewOriginConfig({ ...local, search: "?preview-origin=bunwasm.localhost:4173" })).toEqual({ domain: "bunwasm.localhost:4173" });
  expect(resolvePreviewOriginConfig({ ...local, search: "?preview-origin=http://example.test:4173" })).toEqual({ domain: "example.test:4173", scheme: "http" });
  expect(resolvePreviewOriginConfig({ ...local, search: "" })).toBeNull();
  expect(resolvePreviewOriginConfig({ ...local, search: "?preview-origin=evil.dev/x" })).toBeNull();
  expect(resolvePreviewOriginConfig({ hostname: "ide.app.localhost", port: "80", search: "?preview-origin=app.localhost" })).toEqual({ domain: "app.localhost" });
  expect(resolvePreviewOriginConfig({ hostname: "bun.example.test", port: "", search: "?preview-origin=example.test" })).toEqual({ domain: "example.test" });
  // A crafted link to the public site must not point a workspace's dev server at another domain.
  expect(resolvePreviewOriginConfig({ hostname: "bun.sprockt.dev", port: "", search: "?preview-origin=evil.dev" })).toBeNull();
  expect(resolvePreviewOriginConfig({ hostname: "bun.sprockt.dev", port: "", search: "?preview-origin=evil.dev" }, "sprockt.dev")).toEqual({ domain: "sprockt.dev" });
  expect(resolvePreviewOriginConfig(local, "https://sprockt.dev")).toEqual({ domain: "sprockt.dev", scheme: "https" });
});

test("a new-tab link is an IDE-origin page that names the preview", () => {
  const link = new URL(previewFrameLink(`https://${ID}-5173-pv.sprockt.dev/dashboard?tab=1`, "https://bun.sprockt.dev/playground/", { domain: "sprockt.dev" }));
  expect(link.origin + link.pathname).toBe("https://bun.sprockt.dev/playground/preview-frame.html");
  expect(link.searchParams.get("url")).toBe(`https://${ID}-5173-pv.sprockt.dev/dashboard?tab=1`);
  expect(link.searchParams.get("preview-origin")).toBe("https://sprockt.dev");
});

test("dev servers learn a public preview domain through Vite's variable, and nothing for loopback names", () => {
  expect(previewHostEnv(null)).toEqual({});
  expect(previewHostEnv({ domain: "localhost:4173" })).toEqual({});
  expect(previewHostEnv({ domain: "bunwasm.localhost:4173" })).toEqual({});
  expect(previewHostEnv({ domain: "sprockt.dev" })).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".sprockt.dev" });
  expect(previewHostEnv({ domain: "example.test:8443" })).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".example.test" });
});

test("requests from the preview origin are rebuilt from known fields or dropped", () => {
  const forged = { t: "open", id: 1, url: "https://p.test/", method: "GET", headers: [["a", "b"]], body: null, credentials: "include", authorization: { owner: "x" }, port: 9, route: "ws-other" };
  expect(sessionRequest(forged)).toEqual({ t: "open", id: 1, url: "https://p.test/", method: "GET", headers: [["a", "b"]], body: null, credentials: "include" });
  expect(sessionRequest({ ...forged, credentials: "same-origin" })).toMatchObject({ credentials: "include" });
  expect(sessionRequest({ ...forged, credentials: "omit" })).toMatchObject({ credentials: "omit" });
  for (const bad of [
    null, "open", { t: "grant" }, { ...forged, id: -1 }, { ...forged, id: 1.5 }, { ...forged, method: "GET /x" }, { ...forged, headers: [["a"]] },
    { ...forged, headers: "a: b" }, { ...forged, body: "text" }, { ...forged, url: 5 }, { t: "ping" }, { t: "cookie", id: 1, line: 5, url: "x" },
    { t: "input", id: 1, input: { type: "data", chunk: "bytes" } }, { t: "input", id: 1, input: { type: "grant" } },
  ]) expect(sessionRequest(bad)).toBeNull();
  expect(sessionRequest({ t: "input", id: 3, input: { type: "pull", extra: 1 } })).toEqual({ t: "input", id: 3, input: { type: "pull" } });
  expect(sessionRequest({ t: "cookie", id: 2, line: "a=1", url: "https://p.test/x" })).toEqual({ t: "cookie", id: 2, line: "a=1", url: "https://p.test/x" });
  expect(socketRequest({ type: "open", url: "wss://p.test/hmr", method: "GET", headers: [], authorization: {} })).toEqual({ type: "open", url: "wss://p.test/hmr", method: "GET", headers: [] });
  expect(socketRequest({ type: "data", chunk: "text" })).toBeNull();
  expect(socketRequest({ type: "grant" })).toBeNull();
});

test("window messages are recognized by shape only", () => {
  expect(relayMessage({ type: "bunwasm-preview-relay", event: "ready", port: 1 })).toEqual({ type: "bunwasm-preview-relay", event: "ready" });
  expect(relayMessage({ type: "bunwasm-preview-relay", event: "grant" })).toBeNull();
  expect(relayMessage({ type: "other", event: "ready" })).toBeNull();
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "load", href: "https://p.test/", title: "App" })).toEqual({ type: "bunwasm-preview-frame", event: "load", href: "https://p.test/", title: "App", transient: false });
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "error", href: "https://p.test/", transient: true })?.transient).toBe(true);
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "load" })).toBeNull();
});
