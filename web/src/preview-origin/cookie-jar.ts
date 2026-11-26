// The cookie jar of one preview origin, after RFC 6265 section 5. Browsers drop Set-Cookie from
// service-worker responses and hide Cookie from service-worker requests, so the IDE page keeps the
// jar of record for each preview origin and the page shim keeps a script-visible mirror of it.
import type { ScriptCookie } from "./protocol.js";

export interface Cookie extends ScriptCookie {
  httpOnly: boolean;
  /** Stored for inspection only: a preview is always first-party to itself. */
  sameSite: string | null;
  created: number;
}

const MAX_COOKIES = 180;
const MAX_COOKIE_BYTES = 4096;

function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const last = requestPath.lastIndexOf("/");
  return last <= 0 ? "/" : requestPath.slice(0, last);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function domainMatches(hostname: string, domain: string): boolean {
  const wanted = domain.replace(/^\./, "").toLowerCase();
  return wanted !== "" && (hostname === wanted || hostname.endsWith(`.${wanted}`));
}

interface Parsed {
  cookie: Cookie;
  /** A Domain attribute, which must match the host; the cookie is stored host-only either way. */
  domain: string | null;
  explicitPath: boolean;
}

function expiry(attributes: Map<string, string>, now: number): number | null {
  const maxAge = attributes.get("max-age");
  if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) return Number(maxAge) <= 0 ? 0 : now + Number(maxAge) * 1000;
  const expires = attributes.get("expires");
  if (expires === undefined) return null;
  const time = Date.parse(expires);
  return Number.isNaN(time) ? null : time;
}

function parse(line: string, requestPath: string, now: number): Parsed | null {
  if (line.length > MAX_COOKIE_BYTES || /[\0\r\n]/.test(line)) return null;
  const parts = line.split(";");
  const pair = parts[0]!;
  const equals = pair.indexOf("=");
  const name = equals < 0 ? "" : pair.slice(0, equals).trim();
  const value = (equals < 0 ? pair : pair.slice(equals + 1)).trim();
  if (name === "" && value === "") return null;
  const attributes = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const at = part.indexOf("=");
    attributes.set((at < 0 ? part : part.slice(0, at)).trim().toLowerCase(), at < 0 ? "" : part.slice(at + 1).trim());
  }
  const path = attributes.get("path");
  const explicitPath = path !== undefined && path.startsWith("/");
  return {
    domain: attributes.get("domain") || null,
    explicitPath,
    cookie: {
      name,
      value,
      path: explicitPath ? path : defaultPath(requestPath),
      expires: expiry(attributes, now),
      secure: attributes.has("secure"),
      httpOnly: attributes.has("httponly"),
      sameSite: attributes.get("samesite")?.toLowerCase() ?? null,
      created: now,
    },
  };
}

function prefixAllows(parsed: Parsed): boolean {
  const name = parsed.cookie.name.toLowerCase();
  if (name.startsWith("__secure-")) return parsed.cookie.secure;
  if (!name.startsWith("__host-")) return true;
  return parsed.cookie.secure && parsed.domain === null && parsed.explicitPath && parsed.cookie.path === "/";
}

function isCookie(value: unknown): value is Cookie {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && typeof item.value === "string" && typeof item.path === "string"
    && (item.expires === null || typeof item.expires === "number") && typeof item.secure === "boolean"
    && typeof item.httpOnly === "boolean" && typeof item.created === "number";
}

export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();
  /** Changes whenever the script-visible cookies may have changed. */
  scriptVersion = 0;

  /**
   * @param hostname the preview host, for Domain attributes
   * @param secure whether the origin may hold Secure cookies (https, or a loopback name)
   */
  constructor(private readonly hostname: string, private readonly secure: boolean, initial: readonly unknown[] = []) {
    for (const cookie of initial) {
      if (isCookie(cookie)) this.cookies.set(`${cookie.name}\n${cookie.path}`, { ...cookie, sameSite: cookie.sameSite ?? null });
    }
  }

  /** Applies one Set-Cookie header value. Returns whether the jar changed. */
  setFromHeader(line: string, requestPath: string, now = Date.now()): boolean {
    return this.store(parse(line, requestPath, now), false, now);
  }

  /** Applies a `document.cookie = line` write: it can neither set nor replace an HttpOnly cookie. */
  setFromScript(line: string, documentPath: string, now = Date.now()): boolean {
    return this.store(parse(line, documentPath, now), true, now);
  }

  private store(parsed: Parsed | null, fromScript: boolean, now: number): boolean {
    if (!parsed || !prefixAllows(parsed)) return false;
    const { cookie } = parsed;
    if (parsed.domain !== null && !domainMatches(this.hostname, parsed.domain)) return false;
    if (cookie.secure && !this.secure) return false;
    if (fromScript && cookie.httpOnly) return false;
    const key = `${cookie.name}\n${cookie.path}`;
    const stored = this.cookies.get(key);
    // An expired cookie is gone: it protects nothing, HttpOnly or not.
    const previous = stored && stored.expires !== null && stored.expires <= now ? undefined : stored;
    if (!previous) this.cookies.delete(key);
    if (fromScript && previous?.httpOnly) return false;
    if ((previous && !previous.httpOnly) || !cookie.httpOnly) this.scriptVersion++;
    if (cookie.expires !== null && cookie.expires <= now) return this.cookies.delete(key);
    this.cookies.set(key, previous ? { ...cookie, created: previous.created } : cookie);
    this.evict();
    return true;
  }

  private evict(): void {
    if (this.cookies.size <= MAX_COOKIES) return;
    const oldest = Array.from(this.cookies).toSorted(([, a], [, b]) => a.created - b.created)[0];
    if (oldest) this.cookies.delete(oldest[0]);
  }

  private live(now: number): Cookie[] {
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) this.cookies.delete(key);
    }
    // Longer paths first, then older cookies first (RFC 6265 5.4).
    return Array.from(this.cookies.values()).sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  private pairs(path: string, now: number, script: boolean): string | null {
    const matching = this.live(now).filter(cookie => pathMatches(path, cookie.path) && !(script && cookie.httpOnly));
    if (matching.length === 0) return null;
    return matching.map(cookie => (cookie.name === "" ? cookie.value : `${cookie.name}=${cookie.value}`)).join("; ");
  }

  /** The Cookie header for a request to `path`, or null when no cookie applies. */
  header(path: string, now = Date.now()): string | null {
    return this.pairs(path, now, false);
  }

  /** What `document.cookie` reads on a page at `path`. */
  scriptString(path: string, now = Date.now()): string {
    return this.pairs(path, now, true) ?? "";
  }

  /** Every cookie page script may see, without any HttpOnly cookie. */
  scriptCookies(now = Date.now()): ScriptCookie[] {
    return this.live(now)
      .filter(cookie => !cookie.httpOnly)
      .map(({ name, value, path, expires, secure }) => ({ name, value, path, expires, secure }));
  }

  /** Replaces the script-visible cookies with the IDE's view, keeping nothing else. */
  replaceScriptCookies(cookies: readonly ScriptCookie[], now = Date.now()): void {
    this.cookies.clear();
    for (const cookie of cookies) {
      this.cookies.set(`${cookie.name}\n${cookie.path}`, { ...cookie, httpOnly: false, sameSite: null, created: now });
    }
    this.scriptVersion++;
  }

  /** Everything, for the IDE's own storage. */
  serialize(now = Date.now()): Cookie[] {
    return this.live(now);
  }
}
