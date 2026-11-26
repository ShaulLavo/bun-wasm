import { expect, test } from "bun:test";
import { shimAdmission } from "../src/preview-origin/script-policy";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const SHIM = `${ORIGIN}/__bunwasm-preview/ws.js`;
const admission = (header: string | null, shim = SHIM) => shimAdmission(header, shim);
const OPEN = { allowed: true } as const;
const BLOCKED = { allowed: false } as const;

test("a response without a script policy admits the shim as it is", () => {
  for (const header of [null, "", "img-src 'self'", "frame-ancestors https://bun.sprockt.dev", "img-src *, style-src 'self'"]) {
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
    "'self'", "*", "https:", "http:", "*.sprockt.dev", "https://*.sprockt.dev", `${ORIGIN}`, `${ORIGIN}:443`, `${new URL(ORIGIN).host}:*`,
    `${ORIGIN}/__bunwasm-preview/`, `${ORIGIN}/__bunwasm-preview/ws.js`, "'unsafe-inline' 'self'", "'nonce-n' 'self'",
  ]) expect(admission(`script-src ${sources}`)).toMatchObject(OPEN);
  for (const sources of [
    "'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:", "wss:", "https://cdn.example", "*.example.com", "sprockt.dev",
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
