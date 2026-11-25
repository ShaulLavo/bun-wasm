import { expect, test } from "bun:test";
import { CookieJar } from "../src/preview-origin/cookie-jar";

const NOW = Date.UTC(2026, 10, 25);
const jar = (secure = true, initial: unknown[] = []) => new CookieJar("abc-5173-pv.sprockt.dev", secure, initial);

test("server cookies come back on matching paths, longest path first", () => {
  const cookies = jar();
  expect(cookies.setFromHeader("sid=1; Path=/; HttpOnly", "/", NOW)).toBe(true);
  expect(cookies.setFromHeader("area=admin; Path=/admin", "/", NOW + 1)).toBe(true);
  expect(cookies.setFromHeader("scoped=yes", "/docs/page", NOW + 2)).toBe(true);
  expect(cookies.header("/", NOW)).toBe("sid=1");
  expect(cookies.header("/admin/users", NOW)).toBe("area=admin; sid=1");
  expect(cookies.header("/administrator", NOW)).toBe("sid=1");
  // No Path attribute: the directory of the request path.
  expect(cookies.header("/docs/other", NOW)).toBe("scoped=yes; sid=1");
  expect(cookies.header("/doc", NOW)).toBe("sid=1");
});

test("page script never sees or replaces an HttpOnly cookie", () => {
  const cookies = jar();
  cookies.setFromHeader("sid=secret; Path=/; HttpOnly", "/", NOW);
  cookies.setFromHeader("theme=dark; Path=/", "/", NOW);
  expect(cookies.scriptString("/", NOW)).toBe("theme=dark");
  expect(cookies.scriptCookies(NOW)).toEqual([{ name: "theme", value: "dark", path: "/", expires: null, secure: false }]);
  expect(cookies.setFromScript("sid=stolen; Path=/", "/", NOW)).toBe(false);
  expect(cookies.setFromScript("evil=1; HttpOnly", "/", NOW)).toBe(false);
  expect(cookies.header("/", NOW)).toBe("sid=secret; theme=dark");
  expect(cookies.setFromScript("client=1; Path=/", "/", NOW + 1)).toBe(true);
  expect(cookies.header("/", NOW + 1)).toBe("sid=secret; theme=dark; client=1");
});

test("Max-Age and Expires end a cookie, and Max-Age wins", () => {
  const cookies = jar();
  cookies.setFromHeader("a=1; Max-Age=60", "/", NOW);
  cookies.setFromHeader("b=1; Expires=Thu, 26 Nov 2026 00:00:00 GMT", "/", NOW);
  cookies.setFromHeader("c=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "/", NOW);
  expect(cookies.header("/", NOW + 59_000)).toBe("a=1; b=1; c=1");
  expect(cookies.header("/", NOW + 61_000)).toBe("b=1");
  expect(cookies.header("/", NOW + 2 * 86_400_000)).toBeNull();
  cookies.setFromHeader("d=1", "/", NOW);
  expect(cookies.setFromHeader("d=; Max-Age=0", "/", NOW)).toBe(true);
  expect(cookies.header("/", NOW)).toBeNull();
});

test("a cookie stays on its own host: other domains are refused and Domain never widens it", () => {
  const cookies = jar();
  expect(cookies.setFromHeader("a=1; Domain=evil.dev", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader("b=1; Domain=bun.sprockt.dev", "/", NOW)).toBe(false);
  // A parent domain matches, but the jar is this origin's alone, so no sibling ever receives it.
  expect(cookies.setFromHeader("c=1; Domain=sprockt.dev", "/", NOW)).toBe(true);
  expect(cookies.header("/", NOW)).toBe("c=1");
});

test("Secure and prefixed cookies need what browsers require of them", () => {
  expect(jar(false).setFromHeader("a=1; Secure", "/", NOW)).toBe(false);
  expect(jar(true).setFromHeader("a=1; Secure", "/", NOW)).toBe(true);
  const cookies = jar();
  expect(cookies.setFromHeader("__Secure-a=1", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader("__Secure-a=1; Secure", "/", NOW)).toBe(true);
  expect(cookies.setFromHeader("__Host-b=1; Secure", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader("__Host-b=1; Secure; Path=/; Domain=sprockt.dev", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader("__Host-b=1; Secure; Path=/", "/", NOW)).toBe(true);
});

test("malformed lines are ignored and the script version tracks script-visible changes only", () => {
  const cookies = jar();
  expect(cookies.setFromHeader("", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader("a=1\r\nset-cookie: b=2", "/", NOW)).toBe(false);
  expect(cookies.setFromHeader(`big=${"x".repeat(5000)}`, "/", NOW)).toBe(false);
  const before = cookies.scriptVersion;
  cookies.setFromHeader("sid=1; HttpOnly", "/", NOW);
  expect(cookies.scriptVersion).toBe(before);
  cookies.setFromHeader("theme=dark", "/", NOW);
  expect(cookies.scriptVersion).toBeGreaterThan(before);
});

test("the stored jar restores every cookie, and the page mirror takes only script-visible ones", () => {
  const cookies = jar();
  cookies.setFromHeader("sid=1; Path=/; HttpOnly", "/", NOW);
  cookies.setFromHeader("theme=dark; Path=/", "/", NOW);
  const restored = jar(true, JSON.parse(JSON.stringify(cookies.serialize(NOW))));
  expect(restored.header("/", NOW)).toBe("sid=1; theme=dark");
  expect(jar(true, [{ name: "broken" }, null, "text"]).header("/", NOW)).toBeNull();
  const mirror = jar();
  mirror.setFromScript("stale=1", "/", NOW);
  mirror.replaceScriptCookies(cookies.scriptCookies(NOW), NOW);
  expect(mirror.scriptString("/", NOW)).toBe("theme=dark");
});
