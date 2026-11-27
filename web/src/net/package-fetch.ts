const AUTH_OPTION = /:(?:_authToken|_auth|_?username|_password)=/i;
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "cookie2", "www-authenticate"];

export type PackageRequestKind = "metadata" | "tarball";

export interface PackageRequest {
  readonly url: string;
  readonly kind: PackageRequestKind;
}

/**
 * Rewrites an outbound `bun install` metadata or tarball URL before the browser fetches it.
 * Return a replacement URL (absolute or same-origin relative path) to route the request through
 * a host proxy, or `null` / `undefined` to fetch the original URL directly.
 */
export type PackageUrlRewriter = (request: PackageRequest) => string | URL | null | undefined;

export interface PackageRewrite {
  readonly kind: PackageRequestKind;
  readonly rewriteUrl: PackageUrlRewriter;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function baseHref(): string | undefined {
  return typeof location === "object" && typeof location?.href === "string" ? location.href : undefined;
}

function stripCredentialsOnOriginChange(from: URL, to: URL, headers: Headers): void {
  if (to.origin === from.origin) return;
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
}

function resolveRewrite(current: URL, rewrite?: PackageRewrite): URL {
  if (!rewrite) return current;
  const rewritten = rewrite.rewriteUrl({ url: current.href, kind: rewrite.kind });
  if (rewritten == null) return current;
  if (typeof rewritten === "string" && !rewritten.trim()) {
    throw new TypeError("Rewritten package URL must not be empty");
  }
  const next = rewritten instanceof URL ? new URL(rewritten.href) : new URL(rewritten, baseHref());
  if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || AUTH_OPTION.test(next.href)) {
    throw new TypeError(`Rewritten package URL must use http or https without credentials: ${next.href}`);
  }
  return next;
}

function packageRedirect(current: URL, location: string, headers: Headers): URL {
  const next = new URL(location, current);
  if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || next.search || AUTH_OPTION.test(next.href)) {
    throw new Error("Credential-bearing or unsupported package redirect URL");
  }
  stripCredentialsOnOriginChange(current, next, headers);
  return next;
}

export function resolvePackageRewrite(input: string, rewrite?: PackageRewrite): URL {
  return resolveRewrite(new URL(input), rewrite);
}

export async function packageFetch(
  input: string,
  options: RequestInit,
  fetcher: FetchLike = fetch,
  rewrite?: PackageRewrite,
  initialTarget?: URL,
): Promise<Response> {
  let url = new URL(input);
  const headers = new Headers(options.headers);
  for (let redirects = 0; redirects <= 20; redirects++) {
    const target = redirects === 0 && initialTarget ? initialTarget : resolveRewrite(url, rewrite);
    stripCredentialsOnOriginChange(url, target, headers);
    const response = await fetcher(target.href, { ...options, headers, redirect: "manual" });
    if (response.type === "opaqueredirect") throw new Error("Package redirect destination is unavailable to this browser");
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects === 20) throw new Error("Package response redirected too many times");
    url = packageRedirect(target, location, headers);
  }
  throw new Error("Package response redirected too many times");
}
