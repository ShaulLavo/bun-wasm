/**
 * WebKit logs "Fetch API cannot load <url> due to access control checks." when a parent page
 * navigates an iframe (a new `src`) while a service-worker fetch inside that iframe is still in
 * flight. Playwright's WebKit driver reports every error-level JavaScript console message as a
 * `pageerror`, so the log arrives as one even though the page caught the rejected fetch.
 *
 * The preview loading document (web/src/preview-navigation.ts) polls `.loading/<id>/status`
 * every 250 ms and is replaced whenever the Sandbox re-navigates its preview frame (follower
 * attach, owner failover, transient retries). A cancelled poll is expected there and does not
 * affect the preview, so tests ignore exactly that diagnostic and still fail on every other error.
 */
const diagnostic = /^Fetch API cannot load (\S+) due to access control checks\.$/;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const statusPath = new RegExp(`^(?:/sandbox)?/__preview/\\.loading/${uuid}/status$`);

/**
 * Playwright splits a WebKit console error at its first colon into `name` and `message` and
 * drops the character after that colon (one slash of `http://`), so `name:/message` is the
 * original console text.
 */
export function isCancelledLoadingStatusPoll(error: { readonly name: string; readonly message: string }): boolean {
  const match = diagnostic.exec(`${error.name}:/${error.message}`);
  if (!match) return false;
  let url: URL;
  try {
    url = new URL(match[1]!);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.search === "" && url.hash === "" && statusPath.test(url.pathname);
}
