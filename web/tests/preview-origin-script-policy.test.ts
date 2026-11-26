import { expect, test } from "bun:test";
import { policyEngine, shimAdmission, type PolicyEngine } from "../src/preview-origin/script-policy";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.shaulavo.dev`;
const SHIM = `${ORIGIN}/__bunwasm-preview/ws.js`;
// Where the engines agree, Chromium stands for all three; the tests of the upgrade name each engine.
const admission = (header: string | null, shim = SHIM, engine: PolicyEngine | null = "chromium") => shimAdmission(header, shim, engine);
const OPEN = { allowed: true } as const;
const BLOCKED = { allowed: false } as const;

test("a response without a script policy admits the shim as it is", () => {
  for (const header of [null, "", "img-src 'self'", "frame-ancestors https://bun.shaulavo.dev", "img-src *, style-src 'self'"]) {
    expect(admission(header)).toEqual(OPEN);
  }
});

test("the directive that governs script elements decides: script-src-elem, then script-src, then default-src", () => {
  expect(admission("default-src 'none'; script-src 'self'")).toEqual(OPEN);
  expect(admission("default-src 'self'; script-src 'none'")).toEqual(BLOCKED);
  expect(admission("script-src 'none'; script-src-elem 'self'")).toEqual(OPEN);
  expect(admission("script-src 'self'; script-src-elem 'nonce-e'")).toEqual({ allowed: true, nonce: "e" });
  expect(admission("default-src 'nonce-d'")).toEqual({ allowed: true, nonce: "d" });
  // Only the first directive of a name counts, and names are case-insensitive.
  expect(admission("script-src 'none'; script-src 'self'")).toEqual(BLOCKED);
  expect(admission("SCRIPT-SRC 'SELF'")).toEqual(OPEN);
});

test("a source list admits the shim's own URL by 'self', a wildcard, a scheme or a matching host source", () => {
  for (const sources of [
    "'self'", "*", "https:", "http:", "*.shaulavo.dev", "https://*.shaulavo.dev", `${ORIGIN}`, `${ORIGIN}:443`, `${new URL(ORIGIN).host}:*`,
    `${ORIGIN}/__bunwasm-preview/`, `${ORIGIN}/__bunwasm-preview/ws.js`, "'unsafe-inline' 'self'", "'nonce-n' 'self'",
  ]) expect(admission(`script-src ${sources}`)).toMatchObject(OPEN);
  for (const sources of [
    "'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:", "wss:", "https://cdn.example", "*.example.com", "shaulavo.dev",
    `${ORIGIN}:8443`, `${ORIGIN}/assets/`, `${ORIGIN}/__bunwasm-preview/other.js`,
    "'sha256-RFWPLDbv2BY+rCkDzsE+0fr8ylGr2R2faWMhq4lfEQc='",
  ]) expect(admission(`script-src ${sources}`)).toEqual(BLOCKED);
  // Over plain http only an http source or a wildcard covers it, and a source without a port means port 80.
  const local = "http://abc-5173-pv.localhost:4173/__bunwasm-preview/ws.js";
  expect(admission("script-src https:", local)).toEqual(BLOCKED);
  expect(admission("script-src http:", local)).toEqual(OPEN);
  expect(admission("script-src *.localhost", local)).toEqual(BLOCKED);
  expect(admission("script-src *.localhost:4173", local)).toEqual(OPEN);
});

test("each engine's own rule decides how an http host source covers an https page, and an unknown engine gets the strictest", () => {
  const host = new URL(ORIGIN).hostname;
  const onPort = `https://${host}:8443/__bunwasm-preview/ws.js`;
  const plain = `http://${host}:8080/__bunwasm-preview/ws.js`;
  // [source, the page script's URL, the engines that run the script under that source]
  const cases: [string, string, PolicyEngine[]][] = [
    // An explicit port that is not a default one: Gecko and WebKit let the scheme upgrade on its own, Chromium does not.
    [`http://${host}:8443`, onPort, ["gecko", "webkit"]],
    [`https://${host}:8443`, onPort, ["chromium", "gecko", "webkit"]],
    [`${host}:8443`, onPort, ["chromium", "gecko", "webkit"]],
    [`http://${host}`, onPort, []],
    [`http://${host}:80`, onPort, []],
    [`http://${host}:8444`, onPort, []],
    // The default ports: 80 stands for 443 in Chromium and WebKit only with the scheme upgrade, in Gecko whatever the scheme.
    [`http://${host}:80`, SHIM, ["chromium", "gecko", "webkit"]],
    [`https://${host}:80`, SHIM, ["gecko"]],
    [`${host}:80`, SHIM, ["gecko"]],
    [`http://${host}`, SHIM, ["chromium", "gecko", "webkit"]],
    [`http://${host}:443`, SHIM, ["chromium", "gecko", "webkit"]],
    [`https://${host}:443`, SHIM, ["chromium", "gecko", "webkit"]],
    [`${host}`, SHIM, ["chromium", "gecko", "webkit"]],
    // Plain http on its own port: nothing upgrades anywhere.
    [`http://${host}:8080`, plain, ["chromium", "gecko", "webkit"]],
    [`${host}:8080`, plain, ["chromium", "gecko", "webkit"]],
    [`http://${host}`, plain, []],
    [`https://${host}:8080`, plain, []],
  ];
  for (const [source, shim, running] of cases) {
    for (const engine of ["chromium", "gecko", "webkit"] as const) {
      expect([source, shim, engine, admission(`script-src ${source}`, shim, engine).allowed]).toEqual([source, shim, engine, running.includes(engine)]);
    }
    // No tag is written for an unknown browser unless every engine would run it.
    expect([source, shim, admission(`script-src ${source}`, shim, null).allowed]).toEqual([source, shim, running.length === 3]);
  }
});

test("the engine is read from the service worker's user agent", () => {
  expect(policyEngine("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("gecko");
  expect(policyEngine("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")).toBe("chromium");
  expect(policyEngine("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36 Edg/140.0")).toBe("chromium");
  expect(policyEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15")).toBe("webkit");
  expect(policyEngine("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1")).toBe("webkit");
  expect(policyEngine("TestAgent/1")).toBeNull();
  expect(policyEngine(undefined)).toBeNull();
});

test("an http host source covers the same host over https when scheme and port upgrade together", () => {
  const host = new URL(ORIGIN).hostname;
  // The shim is https on the default port. Browsers let http:80 stand for https:443.
  for (const source of [`http://${host}:80`, `http://${host}`, `http://${host}:443`, `http://*.shaulavo.dev:80`, `HTTP://${host}:80/__bunwasm-preview/`]) {
    expect(admission(`script-src ${source}`)).toEqual(OPEN);
  }
  // Only one of the two would upgrade, or the port is another one altogether.
  for (const source of [`https://${host}:80`, `${host}:80`, `http://${host}:8080`, `http://${host}:81`, `ws://${host}:80`]) {
    expect(admission(`script-src ${source}`)).toEqual(BLOCKED);
  }
  // Over https on another port, and over plain http, nothing upgrades.
  const secureElsewhere = `https://${host}:8443/__bunwasm-preview/ws.js`;
  expect(admission(`script-src http://${host}:80`, secureElsewhere)).toEqual(BLOCKED);
  expect(admission(`script-src http://${host}`, secureElsewhere)).toEqual(BLOCKED);
  expect(admission(`script-src http://${host}:8443`, secureElsewhere)).toEqual(BLOCKED);
  expect(admission(`script-src https://${host}:8443`, secureElsewhere)).toEqual(OPEN);
  const plain = `http://${host}/__bunwasm-preview/ws.js`;
  expect(admission(`script-src http://${host}:80`, plain)).toEqual(OPEN);
  expect(admission(`script-src ${host}`, plain)).toEqual(OPEN);
  expect(admission(`script-src http://${host}:443`, plain)).toEqual(BLOCKED);
  expect(admission(`script-src https://${host}`, plain)).toEqual(BLOCKED);
  // With another policy beside it, the upgraded source still counts as open.
  expect(admission(`script-src http://${host}:80, script-src 'nonce-app'`)).toEqual({ allowed: true, nonce: "app" });
});

test("with 'strict-dynamic' only a nonce admits the tag, whatever hosts the list also names", () => {
  expect(admission("script-src 'self' https: 'strict-dynamic'")).toEqual(BLOCKED);
  expect(admission("script-src 'self' 'nonce-n' 'strict-dynamic'")).toEqual({ allowed: true, nonce: "n" });
  expect(admission("script-src 'sha256-RFWPLDbv2BY+rCkDzsE+0fr8ylGr2R2faWMhq4lfEQc=' 'strict-dynamic'")).toEqual(BLOCKED);
});

test("several policies must all admit the tag: the nonce is one that each demanding policy accepts", () => {
  // A proxy's same-origin policy carries a nonce of its own; only the app's policy needs one.
  expect(admission("script-src 'self' 'nonce-proxy', script-src 'nonce-app'")).toEqual({ allowed: true, nonce: "app" });
  expect(admission("script-src 'nonce-app', script-src 'self' 'nonce-proxy'")).toEqual({ allowed: true, nonce: "app" });
  expect(admission("script-src 'self', default-src *, img-src 'none'")).toEqual(OPEN);
  expect(admission("script-src 'nonce-a' 'nonce-b', script-src 'nonce-b' 'nonce-c', script-src 'nonce-c' 'nonce-b'")).toEqual({ allowed: true, nonce: "b" });
  // No single nonce passes both, and one blocking policy is enough.
  expect(admission("script-src 'nonce-proxy', script-src 'nonce-app'")).toEqual(BLOCKED);
  expect(admission("script-src 'self', script-src 'none'")).toEqual(BLOCKED);
  expect(admission("script-src 'nonce-app', script-src 'sha256-RFWPLDbv2BY+rCkDzsE+0fr8ylGr2R2faWMhq4lfEQc='")).toEqual(BLOCKED);
});

test("a nonce is taken only in the form the grammar allows", () => {
  expect(admission("script-src 'nonce-abc+/_-09=='")).toEqual({ allowed: true, nonce: "abc+/_-09==" });
  for (const source of ["'nonce-'", "'nonce-a b'", "'nonce-a\"b'", "nonce-abc", "'nonce-a<b'"]) expect(admission(`script-src ${source}`)).toEqual(BLOCKED);
});
