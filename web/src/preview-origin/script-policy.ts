// Whether a response's Content-Security-Policy lets the injected page script load, and with which
// nonce. A response may carry several policies (a proxy's and the app's), and a script must pass
// every one of them. Written from CSP Level 3, sections 6.7.2.6 to 6.7.2.8 (source matching).

/** The shim tag passes every policy without a nonce, with this one, or not at all. */
export type ShimAdmission = { allowed: true; nonce?: string } | { allowed: false };

const SCRIPT_DIRECTIVES = ["script-src-elem", "script-src", "default-src"];
const NONCE = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/;
const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** The source list that governs script elements in one policy, or undefined when the policy has none. */
function scriptSources(policy: string): string[] | undefined {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name = "", ...sources] = directive.trim().split(/\s+/);
    // The first directive of a name counts; later ones are ignored (CSP 2.2.1).
    if (name !== "" && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return SCRIPT_DIRECTIVES.map(name => directives.get(name)).find(sources => sources !== undefined);
}

function schemeMatches(source: string, url: URL): boolean {
  const scheme = `${source.toLowerCase()}:`;
  // An http source also covers the same resource over https.
  return scheme === url.protocol || (scheme === "http:" && url.protocol === "https:");
}

function hostMatches(pattern: string, hostname: string): boolean {
  const wanted = pattern.toLowerCase();
  if (wanted === "*") return true;
  if (wanted.startsWith("*.")) return hostname.endsWith(wanted.slice(1));
  return wanted === hostname;
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern === "" || pattern === "/") return true;
  let wanted: string;
  try { wanted = decodeURIComponent(pattern); } catch { return false; }
  return wanted.endsWith("/") ? pathname.startsWith(wanted) : pathname === wanted;
}

/**
 * The engines differ in how an http host source covers an https URL, so the scheme and port of a
 * host source are matched as the engine that will load the page does it.
 */
export type PolicyEngine = "chromium" | "gecko" | "webkit";
const ENGINES: readonly PolicyEngine[] = ["chromium", "gecko", "webkit"];

/** The engine behind a user agent string, or null when it names none of the three. */
export function policyEngine(userAgent: string | undefined): PolicyEngine | null {
  if (!userAgent) return null;
  if (/Firefox\//.test(userAgent)) return "gecko";
  // Headless Chromium says "HeadlessChrome/". Every browser on iOS is WebKit and names neither.
  if (/Chrom(?:e|ium)\//.test(userAgent)) return "chromium";
  return /AppleWebKit\//.test(userAgent) ? "webkit" : null;
}

/** The scheme and port of one host source; both are undefined when the source does not name them. */
interface SourceAuthority { scheme: string | undefined; port: string | undefined }

/** How one part of a host source covers the URL: as written, by the http-to-https upgrade, for any value, or not. */
type PartMatch = "exact" | "upgrade" | "any" | "none";

/** A host source without a scheme takes the page's own, which is the URL's: the script is same-origin. */
function schemePart(scheme: string | undefined, url: URL): PartMatch {
  if (scheme === undefined || `${scheme}:` === url.protocol) return "exact";
  return scheme === "http" && url.protocol === "https:" ? "upgrade" : "none";
}

/**
 * Chromium (CSPSourceMatches, csp_source.cc): `url.port` is empty for the scheme's default port. A
 * source for port 80, or an http source without a port, also covers 443, and scheme and port
 * upgrade together or not at all: `http://host:80` covers `https://host`, `https://host:80` and
 * `http://host:8443` (for `https://host:8443`) do not.
 */
function chromiumCovers(source: SourceAuthority, url: URL): boolean {
  const scheme = schemePart(source.scheme, url);
  const port = source.port ?? "";
  const httpSource = source.scheme === undefined ? url.protocol === "http:" : source.scheme === "http";
  const secureDefault = url.protocol === "https:" && (url.port === "" || url.port === "443");
  let match: PartMatch = url.port === "" && port === DEFAULT_PORT[url.protocol] ? "exact" : "none";
  if (secureDefault && (port === "80" || (httpSource && (port === "" || port === "443")))) match = "upgrade";
  if (port === url.port) match = port === "" ? "any" : "exact";
  if (source.port === "*") match = "any";
  if (scheme === "none" || match === "none") return false;
  const upgrades = scheme === "upgrade" || match === "upgrade";
  return !upgrades || (scheme === "upgrade" && match !== "exact");
}

/**
 * Gecko (permitsPort, nsCSPUtils.cpp): the scheme may upgrade on its own. A source without a port
 * covers a URL on its scheme's default port, else it enforces the source scheme's default port. The
 * enforced port must be the URL's, except that 80 stands for 443 whatever the scheme:
 * `http://host:8443` covers `https://host:8443`, and `http://host:80`, `https://host:80` and
 * `host:80` all cover `https://host`.
 */
function geckoCovers(source: SourceAuthority, url: URL): boolean {
  if (schemePart(source.scheme, url) === "none") return false;
  if (source.port === "*") return true;
  if (source.port === undefined && url.port === "") return true;
  const port = url.port || DEFAULT_PORT[url.protocol];
  const enforced = source.port ?? DEFAULT_PORT[`${source.scheme ?? url.protocol.slice(0, -1)}:`];
  return enforced === port || (enforced === "80" && port === "443");
}

/**
 * WebKit (portMatches, ContentSecurityPolicySource.cpp): the scheme may upgrade on its own. Only
 * an http-to-https upgrade lets a source without a port, or with 80 or 443, cover the secure
 * default port: `http://host:8443` covers `https://host:8443` and `http://host:80` covers
 * `https://host`, but `https://host:80` and `host:80` do not.
 */
function webkitCovers(source: SourceAuthority, url: URL): boolean {
  const scheme = schemePart(source.scheme, url);
  if (scheme === "none") return false;
  if (source.port === "*" || (source.port ?? "") === url.port) return true;
  const upgradable = source.port === undefined || source.port === "80" || source.port === "443";
  if (scheme === "upgrade" && url.protocol === "https:" && url.port === "" && upgradable) return true;
  return url.port === "" && source.port === DEFAULT_PORT[url.protocol];
}

const COVERS: Record<PolicyEngine, (source: SourceAuthority, url: URL) => boolean> = { chromium: chromiumCovers, gecko: geckoCovers, webkit: webkitCovers };

/**
 * Whether a scheme source (`https:`) or host source (`https://*.example.com:443/dir/`) covers
 * `url` in `engine`. For an unknown engine it must cover the URL in all three: a tag is written
 * only where the script will run.
 */
function urlSourceMatches(source: string, url: URL, engine: PolicyEngine | null): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):$/i.exec(source);
  if (scheme) return schemeMatches(scheme[1]!, url);
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\d+|\*))?(\/[^?#]*)?$/i.exec(source);
  if (!host) return false;
  const [, sourceScheme, sourceHost = "", sourcePort, sourcePath = ""] = host;
  const authority: SourceAuthority = { scheme: sourceScheme?.toLowerCase(), port: sourcePort };
  const engines = engine ? [engine] : ENGINES;
  if (!engines.every(name => COVERS[name](authority, url))) return false;
  return hostMatches(sourceHost, url.hostname) && pathMatches(sourcePath, url.pathname);
}

/** What one policy asks of a script element that loads `url` from the page's own origin. */
function policyAdmission(policy: string, url: URL, engine: PolicyEngine | null): { open: boolean; nonces: string[] } {
  const sources = scriptSources(policy);
  if (sources === undefined) return { open: true, nonces: [] };
  const nonces = sources.flatMap(source => NONCE.exec(source)?.[1] ?? []);
  // With 'strict-dynamic', only a nonce (or a hash) admits a parser-inserted script.
  if (sources.some(source => source.toLowerCase() === "'strict-dynamic'")) return { open: false, nonces };
  const open = sources.some((source) => {
    const keyword = source.toLowerCase();
    if (keyword === "'self'") return true;
    if (keyword === "*") return url.protocol === "http:" || url.protocol === "https:";
    return !keyword.startsWith("'") && urlSourceMatches(source, url, engine);
  });
  return { open, nonces };
}

/**
 * Whether a script element for `shimUrl` (a URL of the page's own origin) passes every policy of a
 * Content-Security-Policy header value, and the nonce it needs for that. Policies that only match
 * by hash, or that ask for different nonces, admit no such element: the answer is then "not
 * allowed", and nobody's policy is widened. `engine` is the browser engine that will load the page
 * (`policyEngine`), or null when it is unknown.
 */
export function shimAdmission(header: string | null, shimUrl: string, engine: PolicyEngine | null): ShimAdmission {
  const url = new URL(shimUrl);
  const demanding = (header ?? "").split(",").map(policy => policyAdmission(policy, url, engine)).filter(policy => !policy.open);
  const [first, ...rest] = demanding;
  if (!first) return { allowed: true };
  const nonce = first.nonces.find(candidate => rest.every(policy => policy.nonces.includes(candidate)));
  return nonce === undefined ? { allowed: false } : { allowed: true, nonce };
}
