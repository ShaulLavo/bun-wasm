import { expect, test } from "bun:test";
import {
  frameMessage, isPreviewOrigin, navigationAnswer, parsePreviewHost, previewFrameLink, previewHostEnv, previewOrigin, previewOriginId, relayMessage,
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
  expect(parsePreviewHost(`${ID}-5173-pv.sprockt.dev`, { domain: "sprockt.dev" })).toEqual({ id: ID, port: 5173 });
  expect(parsePreviewHost(`${ID}-3000-pv.localhost:4173`, { domain: "localhost:4173" })).toEqual({ id: ID, port: 3000 });
  expect(() => previewOrigin({ domain: "sprockt.dev" }, "short", 5173)).toThrow();
  expect(() => previewOrigin({ domain: "sprockt.dev" }, ID, 70000)).toThrow();
});

test("a domain written with its scheme's default port makes and matches the same names as one without", () => {
  const configs = [
    { domain: "example.test:443" }, { domain: "example.test" }, { domain: "EXAMPLE.test:443", scheme: "https" as const },
    { domain: "example.test:80", scheme: "http" as const }, { domain: "example.test", scheme: "http" as const },
  ];
  for (const config of configs) {
    const origin = previewOrigin(config, ID, 5173);
    expect(origin).toBe(`${config.scheme ?? "https"}://${ID}-5173-pv.example.test`);
    // What a browser sends as Host, and what `URL.host` reads, carry no default port.
    expect(parsePreviewHost(new URL(origin).host, config)).toEqual({ id: ID, port: 5173 });
    expect(parsePreviewHost(`${ID}-5173-pv.example.test:${config.scheme === "http" ? 80 : 443}`, config)).toEqual({ id: ID, port: 5173 });
    expect(isPreviewOrigin(origin, config)).toBe(true);
  }
  // A port that is not the scheme's default stays part of the name.
  expect(previewOrigin({ domain: "example.test:443", scheme: "http" }, ID, 5173)).toBe(`http://${ID}-5173-pv.example.test:443`);
  expect(parsePreviewHost(`${ID}-5173-pv.example.test`, { domain: "example.test:443", scheme: "http" })).toBeNull();
  expect(parsePreviewHost(`${ID}-5173-pv.example.test:8443`, { domain: "example.test:443" })).toBeNull();
  expect(new URL(previewFrameLink(`https://${ID}-5173-pv.example.test/`, "https://bun.example.test/", { domain: "example.test:443" })).searchParams.get("preview-origin")).toBe("https://example.test");
});

test("only the exact preview name shape is a preview host", () => {
  for (const host of [
    "bun.sprockt.dev", "sprockt.dev", "www-pv.sprockt.dev", `${ID}-pv.sprockt.dev`, `${ID}-0-pv.sprockt.dev`, `${ID}-70000-pv.sprockt.dev`,
    `${ID}-5173-pv.evil.dev`, `${ID}-5173-pv.sprockt.dev.evil.dev`, `x.${ID}-5173-pv.sprockt.dev`, `${ID.slice(1)}-5173-pv.sprockt.dev`,
    `${"A".repeat(51)}1-5173-pv.sprockt.dev`, `${ID}-5173-pvsprockt.dev`,
    `${ID}-5173-pv.sprockt.dev:99999`, `${ID}-5173-pv.sprockt.dev/x`, `user@${ID}-5173-pv.sprockt.dev`,
  ]) expect(parsePreviewHost(host, { domain: "sprockt.dev" })).toBeNull();
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

test("a link never sends a local page's previews to a public domain", () => {
  // The page hands each preview origin a port to its dev server, so the query may only name local hosts.
  const pages = [
    { hostname: "localhost", port: "4173" }, { hostname: "127.0.0.1", port: "4173" }, { hostname: "ide.app.localhost", port: "" },
    { hostname: "bun.example.test", port: "" },
  ];
  // An address has no subdomains, so it is no preview domain either.
  const remote = ["evil.dev", "https://evil.dev", "evil.dev:443", "sprockt.dev", "localhost.evil.dev", "test.evil.dev", "evil.test.dev", "10.0.0.5:4173", "127.0.0.1:9000"];
  for (const page of pages) {
    for (const domain of remote) expect(resolvePreviewOriginConfig({ ...page, search: `?preview-origin=${domain}` })).toBeNull();
    for (const domain of ["localhost:4173", "app.localhost", "other.test:8443"]) {
      expect(resolvePreviewOriginConfig({ ...page, search: `?preview-origin=${domain}` })).toEqual({ domain });
    }
  }
  // A public domain comes from the build (or the server's own configuration) and from nowhere else.
  expect(resolvePreviewOriginConfig({ hostname: "localhost", port: "4173", search: "?preview-origin=evil.dev" }, "sprockt.dev")).toEqual({ domain: "sprockt.dev" });
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
  expect(sessionRequest({ ...forged, credentials: "omit" })).toMatchObject({ credentials: "omit" });
  for (const bad of [
    null, "open", { t: "grant" }, { ...forged, id: -1 }, { ...forged, id: 1.5 }, { t: "ping" }, { t: "cookie", id: 1, line: 5, url: "x" },
    { t: "input", id: 1, input: { type: "data", chunk: "bytes" } }, { t: "input", id: 1, input: { type: "grant" } },
  ]) expect(sessionRequest(bad)).toBeNull();
  // An open that names its exchange but is not well formed is answered with a refusal, never dispatched.
  for (const malformed of [
    { ...forged, credentials: undefined }, { ...forged, credentials: "same-origin" }, { ...forged, credentials: "INCLUDE" }, { ...forged, credentials: true },
    { ...forged, method: "GET /x" }, { ...forged, url: 5 }, { ...forged, body: "text" }, { ...forged, headers: "a: b" }, { ...forged, headers: [["a"]] },
    { ...forged, headers: [["a", "b", "c"]] }, { ...forged, headers: [["", "b"]] }, { ...forged, headers: [["a b", "c"]] }, { ...forged, headers: [["a:", "c"]] },
    { ...forged, headers: [["a", "b\r\nx-injected: 1"]] }, { ...forged, headers: [["a", "b\0"]] }, { ...forged, headers: [["a\r\n", "b"]] },
    { ...forged, headers: [["a", 5]] }, { ...forged, headers: [[5, "b"]] }, { ...forged, headers: [["a", " "]] },
  ]) expect(sessionRequest(malformed)).toEqual({ t: "invalid", id: 1 });
  expect(sessionRequest({ ...forged, headers: [["x-tab", "a\tb"], ["x-latin", "café"], ["x-empty", ""]] })).toMatchObject({ t: "open" });
  expect(socketRequest({ type: "open", url: "wss://p.test/hmr", method: "GET", headers: [["a", "b\r\nc: d"]] })).toEqual({ type: "invalid" });
  expect(socketRequest({ type: "open", url: "wss://p.test/hmr", method: "GET /x", headers: [] })).toEqual({ type: "invalid" });
  // A sparse list has holes that `every` and `filter` skip: each index is read, and a hole is no header.
  const trailing: [string, string][] = [["a", "b"]];
  trailing.length = 2;
  const inner: [string, string][] = [["a", "b"]];
  inner[2] = ["c", "d"];
  const holes: [string, string][] = [];
  holes.length = 3;
  const halfPair = ["a", "b"];
  delete halfPair[0];
  for (const headers of [trailing, inner, holes, [halfPair]]) {
    expect(sessionRequest({ ...forged, headers })).toEqual({ t: "invalid", id: 1 });
    expect(socketRequest({ type: "open", url: "wss://p.test/hmr", method: "GET", headers })).toEqual({ type: "invalid" });
  }
  // What passes is rebuilt: a dense list of fresh pairs, without anything else hung on the arrays.
  const decorated: [string, string][] = [["a", "b"]];
  Object.assign(decorated, { grant: "x" });
  const rebuilt = sessionRequest({ ...forged, headers: decorated });
  expect(rebuilt).toMatchObject({ t: "open", headers: [["a", "b"]] });
  expect(rebuilt?.t === "open" && rebuilt.headers !== decorated && rebuilt.headers[0] !== decorated[0] && Object.keys(rebuilt.headers)).toEqual(["0"]);
  expect(socketRequest({ type: "ping", extra: 1 })).toEqual({ type: "ping" });
  expect(sessionRequest({ t: "input", id: 3, input: { type: "pull", extra: 1 } })).toEqual({ t: "input", id: 3, input: { type: "pull" } });
  expect(sessionRequest({ t: "cookie", id: 2, line: "a=1", url: "https://p.test/x" })).toEqual({ t: "cookie", id: 2, line: "a=1", url: "https://p.test/x" });
  expect(socketRequest({ type: "open", url: "wss://p.test/hmr", method: "GET", headers: [], authorization: {} })).toEqual({ type: "open", url: "wss://p.test/hmr", method: "GET", headers: [] });
  expect(socketRequest({ type: "data", chunk: "text" })).toBeNull();
  expect(socketRequest({ type: "grant" })).toBeNull();
});

test("a navigation answer from another tab is taken by shape only", () => {
  expect(navigationAnswer({ url: "https://p.test/a", status: 302, location: "/b", extra: 1 })).toEqual({ url: "https://p.test/a", status: 302, location: "/b" });
  expect(navigationAnswer({ url: "https://p.test/a", status: 200, location: null })).toEqual({ url: "https://p.test/a", status: 200, location: null });
  for (const bad of [null, "x", {}, { url: 5, status: 200, location: null }, { url: "https://p.test/", status: "200", location: null }, { url: "https://p.test/", status: 200 }, { url: "https://p.test/", status: 200, location: 5 }]) {
    expect(navigationAnswer(bad)).toBeNull();
  }
});

test("window messages are recognized by shape only", () => {
  expect(relayMessage({ type: "bunwasm-preview-relay", event: "ready", port: 1 })).toEqual({ type: "bunwasm-preview-relay", event: "ready" });
  expect(relayMessage({ type: "bunwasm-preview-relay", event: "grant" })).toBeNull();
  expect(relayMessage({ type: "other", event: "ready" })).toBeNull();
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "load", href: "https://p.test/", title: "App" })).toEqual({ type: "bunwasm-preview-frame", event: "load", href: "https://p.test/", title: "App", transient: false });
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "error", href: "https://p.test/", transient: true })?.transient).toBe(true);
  expect(frameMessage({ type: "bunwasm-preview-frame", event: "load" })).toBeNull();
});
