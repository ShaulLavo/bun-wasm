const AUTH_OPTION = /:(?:_authToken|_auth|_?username|_password)=/i;
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "cookie2", "www-authenticate"];

function packageRedirect(current: URL, location: string, headers: Headers): URL {
  const next = new URL(location, current);
  if (!["https:", "http:"].includes(next.protocol) || next.username || next.password || next.search || AUTH_OPTION.test(next.href)) {
    throw new Error("Credential-bearing or unsupported package redirect URL");
  }
  if (next.origin !== current.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return next;
}

export async function packageFetch(input: string, options: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  let url = new URL(input);
  const headers = new Headers(options.headers);
  for (let redirects = 0; redirects <= 20; redirects++) {
    const response = await fetcher(url.href, { ...options, headers, redirect: "manual" });
    if (response.type === "opaqueredirect") throw new Error("Package redirect destination is unavailable to this browser");
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects === 20) throw new Error("Package response redirected too many times");
    url = packageRedirect(url, location, headers);
  }
  throw new Error("Package response redirected too many times");
}
