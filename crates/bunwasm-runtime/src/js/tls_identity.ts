// MIT-licensed Bun/Node port. Copyright Joyent, Inc. and other Node contributors.
// See docs/bun-patches/node-tls-identity.md for the pin, changes, and license.
(function (internal: BunWasm.TlsIdentityInternal): BunWasm.TlsIdentity {
  "use strict";
  const { isIP } = internal.require("net_address");
  const invalidDnsCharacters = /[^A-Za-z0-9._-]/;

  function identityError(code: BunWasm.TlsIdentityErrorCode, reason: string): BunWasm.TlsIdentityError {
    const message = code === "ERR_TLS_CERT_ALTNAME_INVALID" ? `Hostname/IP does not match certificate's altnames: ${reason}` : reason;
    return Object.assign(new Error(message), { code, reason });
  }

  function displayName(value: string): string {
    let result = "";
    for (const character of value.slice(0, 256)) result += displayCharacter(character);
    return result + (value.length > 256 ? "..." : "");
  }

  function displayCharacter(character: string): string {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f ? character : `\\u${code.toString(16).padStart(4, "0")}`;
  }

  function hasUnsafeIdentityCharacter(value: string): boolean {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f || "/?#[]@\\%:".includes(character)) return true;
    }
    return false;
  }

  function hasNonPrintableCharacter(value: string): boolean {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 0x21 || code > 0x7f) return true;
    }
    return false;
  }

  function hasNonAsciiCharacter(value: string): boolean {
    for (const character of value) if (character.charCodeAt(0) > 0x7f) return true;
    return false;
  }

  function unfqdn(value: string): string {
    return value.endsWith(".") ? value.slice(0, -1) : value;
  }

  function splitHost(value: string): string[] {
    return unfqdn(value).replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32)).split(".");
  }

  function quotedAltName(text: string): { value: string; length: number } {
    let escaped = false;
    for (let index = 1; index < text.length; index++) {
      const character = text.charAt(index);
      if (character === '"' && !escaped) return parseQuotedAltName(text.slice(0, index + 1));
      escaped = character === "\\" && !escaped;
    }
    throw identityError("ERR_TLS_CERT_ALTNAME_FORMAT", "Invalid certificate subject alternative name format");
  }

  function parseQuotedAltName(text: string): { value: string; length: number } {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "string") return { value, length: text.length };
    } catch {
      // JSON.parse enforces the pinned helper's exact JSON string grammar.
    }
    throw identityError("ERR_TLS_CERT_ALTNAME_FORMAT", "Invalid certificate subject alternative name format");
  }

  function splitEscapedAltNames(altNames: string): string[] {
    const result: string[] = [];
    let token = "";
    let offset = 0;
    while (offset !== altNames.length) {
      const separator = altNames.indexOf(", ", offset);
      const quote = altNames.indexOf('"', offset);
      if (quote !== -1 && (separator === -1 || quote < separator)) {
        const parsed = quotedAltName(altNames.slice(quote));
        token += altNames.slice(offset, quote) + parsed.value;
        offset = quote + parsed.length;
        continue;
      }
      if (separator !== -1) {
        result.push(token + altNames.slice(offset, separator));
        token = "";
        offset = separator + 2;
        continue;
      }
      token += altNames.slice(offset);
      offset = altNames.length;
    }
    result.push(token);
    return result;
  }

  function ipFamily(value: string): 0 | 4 | 6 {
    for (const character of value) if (character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) return 0;
    return isIP(value);
  }

  function canonicalizeIP(value: string): string | undefined {
    const family = ipFamily(value);
    if (family === 0) return undefined;
    if (family === 4) return value;
    const zone = value.indexOf("%");
    const bare = zone === -1 ? value : value.slice(0, zone);
    const canonical = internal.native.domainToASCII(`[${bare}]`);
    return canonical.startsWith("[") && canonical.endsWith("]") ? canonical.slice(1, -1) : undefined;
  }

  function toAscii(value: string): string {
    // domainToASCII is URL-backed; reject its delimiters before that native call.
    if (hasUnsafeIdentityCharacter(value)) return "";
    if (!hasNonAsciiCharacter(value)) return value;
    return internal.native.domainToASCII(value);
  }

  function validDnsName(value: string): string | undefined {
    const ascii = unfqdn(toAscii(value));
    if (!ascii || ascii.length > 253 || invalidDnsCharacters.test(ascii)) return undefined;
    if (ascii.split(".").some(part => part.length === 0 || part.length > 63)) return undefined;
    return ascii;
  }

  function checkName(hostParts: readonly string[], pattern: string): boolean {
    if (!pattern) return false;
    const patternParts = splitHost(pattern);
    if (hostParts.length !== patternParts.length || patternParts.includes("")) return false;
    if (patternParts.some(hasNonPrintableCharacter)) return false;
    for (let index = hostParts.length - 1; index > 0; index -= 1) {
      if (hostParts[index] !== patternParts[index]) return false;
    }
    const [hostSubdomain] = hostParts;
    const [patternSubdomain] = patternParts;
    if (hostSubdomain === undefined || patternSubdomain === undefined) return false;
    const [prefix, suffix, extra] = patternSubdomain.split("*");
    if (suffix === undefined || patternSubdomain.includes("xn--")) return hostSubdomain === patternSubdomain;
    if (prefix === undefined || extra !== undefined || patternParts.length <= 2 || hostSubdomain === "") return false;
    if (prefix.length + suffix.length > hostSubdomain.length) return false;
    return hostSubdomain.startsWith(prefix) && hostSubdomain.endsWith(suffix);
  }

  function certificateNames(altNames: string | undefined): { dnsNames: string[]; ips: (string | undefined)[] } {
    const dnsNames: string[] = [];
    const ips: (string | undefined)[] = [];
    if (!altNames) return { dnsNames, ips };
    const names = altNames.includes('"') ? splitEscapedAltNames(altNames) : altNames.split(", ");
    for (const name of names) {
      if (name.startsWith("DNS:")) dnsNames.push(name.slice(4));
      else if (name.startsWith("IP Address:")) ips.push(canonicalizeIP(name.slice(11)));
    }
    return { dnsNames, ips };
  }

  function checkServerIdentity(hostname: unknown, cert: BunWasm.TlsPeerCertificate): BunWasm.TlsIdentityError | undefined {
    const subject = cert.subject;
    const altNames = cert.subjectaltname;
    const rawHostname = String(hostname);
    const hostnameWithoutFqdn = unfqdn(rawHostname);
    const names = certificateNames(altNames);
    if (ipFamily(hostnameWithoutFqdn)) {
      const ip = canonicalizeIP(hostnameWithoutFqdn);
      if (ip !== undefined && names.ips.includes(ip)) return undefined;
      return identityError("ERR_TLS_CERT_ALTNAME_INVALID", `IP: ${displayName(hostnameWithoutFqdn)} is not in the cert's list: ${displayName(names.ips.join(", "))}`);
    }
    const ascii = validDnsName(rawHostname);
    const hostParts = ascii === undefined ? [] : splitHost(ascii);
    const matches = (pattern: string): boolean => checkName(hostParts, pattern);
    if (names.dnsNames.length > 0) {
      if (names.dnsNames.some(matches)) return undefined;
      return identityError("ERR_TLS_CERT_ALTNAME_INVALID", `Host: ${displayName(hostnameWithoutFqdn)}. is not in the cert's altnames: ${displayName(altNames ?? "")}`);
    }
    const commonName = subject?.CN;
    if (!commonName) return identityError("ERR_TLS_CERT_ALTNAME_INVALID", "Cert does not contain a DNS name");
    const valid = typeof commonName === "string" ? matches(commonName) : commonName.some(matches);
    if (valid) return undefined;
    return identityError("ERR_TLS_CERT_ALTNAME_INVALID", `Host: ${displayName(hostnameWithoutFqdn)}. is not cert's CN: ${displayName(typeof commonName === "string" ? commonName : commonName.join(","))}`);
  }

  function selectTarget(options: BunWasm.TlsIdentityTargetOptions): BunWasm.TlsIdentityTarget | BunWasm.TlsIdentityError {
    const candidate = options.servername || (options.connectHost ?? options.originalTarget);
    if (!candidate) {
      if (options.rejectUnauthorized === false) return { kind: "none", hostname: undefined, servername: "" };
      return identityError("ERR_TLS_HOSTNAME_REQUIRED", "Cannot verify hostname without a server name");
    }
    const hostname = unfqdn(candidate);
    if (ipFamily(hostname)) return { kind: "ip", hostname, servername: "" };
    const ascii = validDnsName(candidate);
    if (ascii === undefined) return identityError("ERR_INVALID_ARG_VALUE", "Invalid TLS server name");
    const servername = options.servername && !ipFamily(ascii) ? ascii : "";
    return { kind: "dns", hostname, servername };
  }

  function failure(error: Error, rejectUnauthorized: boolean): BunWasm.TlsIdentityDecision {
    return { kind: rejectUnauthorized === false ? "unauthorized" : "rejected", authorizationError: error };
  }

  function verifyIdentity(verification: BunWasm.TlsIdentityVerification): BunWasm.TlsIdentityDecision {
    if (!verification.chainVerified) return failure(verification.authorizationError, verification.rejectUnauthorized);
    const { target, cert, rejectUnauthorized } = verification;
    if (target.kind === "none") return failure(identityError("ERR_TLS_HOSTNAME_REQUIRED", "Cannot verify hostname without a server name"), rejectUnauthorized);
    const check = verification.checkServerIdentity ?? checkServerIdentity;
    try {
      const error: unknown = check(target.hostname, cert);
      if (error === undefined) return { kind: "authorized" };
      if (internal.require("util").types.isNativeError(error)) return failure(error, rejectUnauthorized);
      return { kind: "rejected", authorizationError: identityError("ERR_INVALID_ARG_TYPE", "checkServerIdentity must return an Error or undefined") };
    } catch (error) {
      if (internal.require("util").types.isNativeError(error)) return { kind: "rejected", authorizationError: error };
      return { kind: "rejected", authorizationError: identityError("ERR_INVALID_ARG_TYPE", "checkServerIdentity threw a non-Error value") };
    }
  }

  return { checkServerIdentity, selectTarget, verifyIdentity };
})
