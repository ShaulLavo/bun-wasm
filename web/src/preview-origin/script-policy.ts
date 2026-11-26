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

/** How one part of a host source covers the URL: as written, by the http-to-https upgrade, for any value, or not. */
type PartMatch = "exact" | "upgrade" | "any" | "none";

/** A host source without a scheme takes the page's own, which is the URL's: the script is same-origin. */
function hostSourceScheme(sourceScheme: string | undefined, url: URL): PartMatch {
  if (sourceScheme === undefined) return "exact";
  const scheme = `${sourceScheme.toLowerCase()}:`;
  if (scheme === url.protocol) return "exact";
  return scheme === "http:" && url.protocol === "https:" ? "upgrade" : "none";
}

/**
 * `url.port` is empty for the scheme's default port. A source for port 80, or an http source that
 * names no port, also covers the same host on 443: the port half of the http-to-https upgrade.
 */
function hostSourcePort(sourcePort: string | undefined, httpSource: boolean, url: URL): PartMatch {
  if (sourcePort === "*") return "any";
  const port = sourcePort ?? "";
  if (port === url.port) return port === "" ? "any" : "exact";
  const secureDefault = url.protocol === "https:" && (url.port === "" || url.port === "443");
  if (secureDefault && (port === "80" || (httpSource && (port === "" || port === "443")))) return "upgrade";
  return url.port === "" && port === DEFAULT_PORT[url.protocol] ? "exact" : "none";
}

/**
 * Whether a scheme source (`https:`) or host source (`https://*.example.com:443/dir/`) covers `url`.
 * Scheme and port upgrade together or not at all, as browsers apply it: `http://host:80` covers
 * `https://host` (both upgrade), `https://host:80` does not (only the port would).
 */
function urlSourceMatches(source: string, url: URL): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):$/i.exec(source);
  if (scheme) return schemeMatches(scheme[1]!, url);
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\d+|\*))?(\/[^?#]*)?$/i.exec(source);
  if (!host) return false;
  const [, sourceScheme, sourceHost = "", sourcePort, sourcePath = ""] = host;
  const schemeMatch = hostSourceScheme(sourceScheme, url);
  const httpSource = sourceScheme === undefined ? url.protocol === "http:" : sourceScheme.toLowerCase() === "http";
  const portMatch = hostSourcePort(sourcePort, httpSource, url);
  if (schemeMatch === "none" || portMatch === "none") return false;
  const upgrades = schemeMatch === "upgrade" || portMatch === "upgrade";
  if (upgrades && (schemeMatch !== "upgrade" || portMatch === "exact")) return false;
  return hostMatches(sourceHost, url.hostname) && pathMatches(sourcePath, url.pathname);
}

/** What one policy asks of a script element that loads `url` from the page's own origin. */
function policyAdmission(policy: string, url: URL): { open: boolean; nonces: string[] } {
  const sources = scriptSources(policy);
  if (sources === undefined) return { open: true, nonces: [] };
  const nonces = sources.flatMap(source => NONCE.exec(source)?.[1] ?? []);
  // With 'strict-dynamic', only a nonce (or a hash) admits a parser-inserted script.
  if (sources.some(source => source.toLowerCase() === "'strict-dynamic'")) return { open: false, nonces };
  const open = sources.some((source) => {
    const keyword = source.toLowerCase();
    if (keyword === "'self'") return true;
    if (keyword === "*") return url.protocol === "http:" || url.protocol === "https:";
    return !keyword.startsWith("'") && urlSourceMatches(source, url);
  });
  return { open, nonces };
}

/**
 * Whether a script element for `shimUrl` (a URL of the page's own origin) passes every policy of a
 * Content-Security-Policy header value, and the nonce it needs for that. Policies that only match
 * by hash, or that ask for different nonces, admit no such element: the answer is then "not
 * allowed", and nobody's policy is widened.
 */
export function shimAdmission(header: string | null, shimUrl: string): ShimAdmission {
  const url = new URL(shimUrl);
  const demanding = (header ?? "").split(",").map(policy => policyAdmission(policy, url)).filter(policy => !policy.open);
  const [first, ...rest] = demanding;
  if (!first) return { allowed: true };
  const nonce = first.nonces.find(candidate => rest.every(policy => policy.nonces.includes(candidate)));
  return nonce === undefined ? { allowed: false } : { allowed: true, nonce };
}
