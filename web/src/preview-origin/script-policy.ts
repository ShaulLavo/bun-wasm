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

/** Whether a scheme source (`https:`) or host source (`https://*.example.com:443/dir/`) covers `url`. */
function urlSourceMatches(source: string, url: URL): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):$/i.exec(source);
  if (scheme) return schemeMatches(scheme[1]!, url);
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\d+|\*))?(\/[^?#]*)?$/i.exec(source);
  if (!host) return false;
  const [, sourceScheme, sourceHost = "", sourcePort, sourcePath = ""] = host;
  if (sourceScheme !== undefined && !schemeMatches(sourceScheme, url)) return false;
  if (!hostMatches(sourceHost, url.hostname)) return false;
  const port = url.port || DEFAULT_PORT[url.protocol] || "";
  // Without a port a source means the default port of the scheme in use.
  const portMatches = sourcePort === "*" || (sourcePort ?? DEFAULT_PORT[url.protocol]) === port;
  return portMatches && pathMatches(sourcePath, url.pathname);
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
