# Client readiness in application fixtures

A server-rendered marker proves that a page rendered, not that its client handlers are attached.
The fullstack fixture owns that knowledge. The browser driver uses declared DOM state and normal
HTML actionability, rather than framework internals, delays, repeated clicks or global flags.

A listening preview port is not an HTTP-ready application. Before the one page navigation, the browser
runner opens a probe page in the preview's own browser context and turns off its script execution, so
neither the loading page nor the application runs there. The probe navigates to the preview URL the same
way the application page will: through the mounted service worker or the root preview origin, the
context's network routing and ordinary redirects. It retries only HTTP 503 responses, within the
existing absolute command deadline, which also bounds response headers and bodies. A non-503 failure or
a navigation error fails immediately with its original error. If 503 continues until the deadline, the
runner reports the last complete 503 body. The runner closes the probe, then navigates once.

TanStack Start and SvelteKit publish `data-hydrated="true"` on the marker after their client mount
lifecycle runs. Their page selector includes that attribute, so the first source edit cannot race
initial hydration. Their counter button is disabled until the same lifecycle completes, so a fresh
navigation cannot expose an actionable SSR-only button. The loader, counter update, source marker
and package configuration are otherwise unchanged. This contract applies to dev and production.

A successful hot edit also owns its rollback. After verifying the forward DOM change and a
recognized development WebSocket message, the driver restores the original source, waits for the
edited marker to disappear and the original marker to return, and requires fresh WebSocket
evidence. All of that uses the original edit deadline. A full document replacement re-arms the
traffic observer for rollback. Later probes start only after that successful lifecycle completes.

The rollback check cannot use only a substring match for the original text: an edited marker can
contain the original marker. It explicitly waits for the edited marker to be hidden.

If the forward edit fails, restoration is attempted without replacing that original failure, even
when the restoration write also rejects. A rollback failure after verified forward HMR still fails
the case. That cleanup
write does not turn a missing HMR message into a pass or grant another timeout. SSR-query, DOM and
interaction observations keep their existing assertions and navigation order.

`product-browser.test.ts` covers HTTP readiness, delayed client mount, SSR button actionability,
rollback DOM lag after early WebSocket evidence, and document replacement. The fixture catalog tests verify
the source marker, readiness selector, dependencies and real command entry points.
