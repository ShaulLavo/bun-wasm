/**
 * WebKit logs "Fetch API cannot load <url> due to access control checks." when a parent page
 * navigates an iframe (a new `src`) while a service-worker fetch inside that iframe is still in
 * flight. Playwright's WebKit driver reports every error-level JavaScript console message as a
 * `pageerror`, so the log arrives as one even though the page caught the rejected fetch.
 *
 * The preview loading document (web/src/preview-navigation.ts) polls `.loading/<id>/status`
 * every 250 ms and is replaced whenever the Sandbox re-navigates its preview frame (follower
 * attach, owner failover, transient retries). A cancelled poll is expected there and does not
 * affect the preview, so tests ignore exactly that message and still fail on every other error.
 */
const cancelledLoadingStatusPoll = /\/__preview\/\.loading\/[0-9a-f-]{36}\/status due to access control checks\.?$/;

export function isCancelledLoadingStatusPoll(message: string): boolean {
  return cancelledLoadingStatusPoll.test(message);
}
