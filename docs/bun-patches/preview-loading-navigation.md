# Slow preview navigations

Classification: original local adapter. No upstream implementation is copied or
patched. `web/src/preview-navigation.ts` wraps Waffle's exported preview router.

WebKit abandons a service-worker fetch that has not produced a response head
after 70 seconds. A guest server can legitimately take longer to compile its
first route. Increasing a test deadline cannot keep that navigation alive.

For a mounted GET navigation, Bun starts the original guest request and immediately
redirects to a private loading document in the same service-worker scope. This
document polls short status requests while the guest prepares its real response.
Once the head arrives, it replaces itself with the original application URL.
The loading document's browser-supplied same-origin referrer identifies the saved
response. Each navigation has a separate random identity, including simultaneous
requests for the same application URL.
Fragment identifiers survive the temporary redirect. Reloading the loading page
retains its request, while cancellation from its replaced document is ignored.

The final navigation receives that original response, including its status,
headers and streaming body. It does not issue a second guest request, send an
invented success head, buffer the whole body, or impose a compile deadline.
Closing the loading page cancels its pending response body. Subresources,
non-GET navigations and root-origin previews retain their existing transport.

The WebKit mechanism is in
[`ServiceWorkerFetchTask::timeoutTimerFired`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/ServiceWorker/ServiceWorkerFetchTask.cpp),
with the default in
[`NetworkProcess::defaultServiceWorkerFetchTimeout`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/NetworkProcess.cpp).
