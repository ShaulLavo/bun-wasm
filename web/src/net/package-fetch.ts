const AUTH_OPTION = /:(?:_authToken|_auth|_?username|_password)=/i;
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "cookie2", "www-authenticate"];

export type PackageRequestKind = "metadata" | "tarball";

export interface PackageRequest {
  readonly url: string;
  readonly kind: PackageRequestKind;
}

export interface PackageRewriteResult {
  readonly url: string | URL;
  /**
   * Fetch credentials mode for the rewritten request. Pass `"omit"` for a public/anonymous
   * proxy (including same-origin proxies) so no ambient cookies are sent and responses can
   * use shared Cache Storage.
   */
  readonly credentials?: RequestCredentials;
}

/**
 * Rewrites an outbound `bun install` metadata or tarball URL before the browser fetches it.
 * Return a replacement URL (absolute or same-origin relative path) or `{ url, credentials }`
 * to route the request through a host proxy, or `null` / `undefined` to fetch the original
 * URL directly.
 */
export type PackageUrlRewriter = (
  request: PackageRequest,
) => string | URL | PackageRewriteResult | null | undefined;

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

interface ResolvedRewrite {
  readonly target: URL;
  readonly rewritten: boolean;
  readonly credentials?: RequestCredentials;
}

function resolveRewrite(current: URL, rewrite?: PackageRewrite): ResolvedRewrite {
  if (!rewrite) return { target: current, rewritten: false };
  const rewritten = rewrite.rewriteUrl({ url: current.href, kind: rewrite.kind });
  if (rewritten == null) return { target: current, rewritten: false };
  const isObject = typeof rewritten === "object" && !(rewritten instanceof URL);
  const rawUrl = isObject ? rewritten.url : rewritten;
  const credentials = isObject ? rewritten.credentials : undefined;
  if (typeof rawUrl === "string" && !rawUrl.trim()) {
    throw new TypeError("Rewritten package URL must not be empty");
  }
  const next = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl, baseHref());
  if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || AUTH_OPTION.test(next.href)) {
    throw new TypeError(`Rewritten package URL must use http or https without credentials: ${next.href}`);
  }
  return { target: next, rewritten: true, credentials };
}

function packageRedirect(current: URL, location: string, headers: Headers): URL {
  const next = new URL(location, current);
  if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || next.search || AUTH_OPTION.test(next.href)) {
    throw new Error("Credential-bearing or unsupported package redirect URL");
  }
  stripCredentialsOnOriginChange(current, next, headers);
  return next;
}

function redactPackageUrl(url: URL): string {
  if (AUTH_OPTION.test(url.href)) return "[redacted registry authentication]";
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.href;
}

function formatHopFetchError(target: URL, error: unknown, signal: AbortSignal | null | undefined): unknown {
  if (signal?.aborted) return error;
  const safeUrl = redactPackageUrl(target);
  const detail = error instanceof Error ? error.message : String(error);
  const message = detail.includes(safeUrl) ? detail : `GET ${safeUrl} - ${detail}`;
  return new Error(message, { cause: error });
}

function ensureEffectiveResponseUrl(response: Response, target: URL, redirected: boolean): Response {
  if (response.url) return response;
  Object.defineProperty(response, "url", { configurable: true, value: redactPackageUrl(target) });
  if (redirected && !response.redirected) {
    Object.defineProperty(response, "redirected", { configurable: true, value: true });
  }
  return response;
}

async function fetchHop(
  fetcher: FetchLike,
  hopUrl: string,
  target: URL,
  options: RequestInit,
  headers: Headers,
  rewritten: boolean,
  credentials: RequestCredentials | undefined,
  redirects: number,
): Promise<Response> {
  const hopOptions: RequestInit = credentials === undefined
    ? { ...options, headers, redirect: "manual" }
    : { ...options, headers, redirect: "manual", credentials };
  try {
    return await fetcher(hopUrl, hopOptions);
  } catch (error) {
    throw redirects > 0 || rewritten ? formatHopFetchError(target, error, options.signal) : error;
  }
}

export async function packageFetch(
  input: string,
  options: RequestInit,
  fetcher: FetchLike = fetch,
  rewrite?: PackageRewrite,
): Promise<Response> {
  let url = new URL(input);
  const headers = new Headers(options.headers);
  let carriedCredentials = options.credentials;
  for (let redirects = 0; redirects <= 20; redirects++) {
    const { target, rewritten, credentials } = resolveRewrite(url, rewrite);
    const hopCredentials = rewritten && credentials !== undefined ? credentials : carriedCredentials;
    if (hopCredentials === "omit") carriedCredentials = "omit";
    const hopUrl = redirects === 0 && !rewritten ? input : target.href;
    stripCredentialsOnOriginChange(url, target, headers);
    const response = await fetchHop(fetcher, hopUrl, target, options, headers, rewritten, hopCredentials, redirects);
    if (response.type === "opaqueredirect") {
      const message = "Package redirect destination is unavailable to this browser";
      throw redirects > 0 || rewritten
        ? new Error(`GET ${redactPackageUrl(target)} - ${message}`)
        : new Error(message);
    }
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
      return redirects > 0 || rewritten ? ensureEffectiveResponseUrl(response, target, redirects > 0) : response;
    }
    await response.body?.cancel();
    if (redirects === 20) throw new Error("Package response redirected too many times");
    url = packageRedirect(target, location, headers);
  }
  throw new Error("Package response redirected too many times");
}
