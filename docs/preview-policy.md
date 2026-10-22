# Preview document policy

The playground's preview policy is opt-in. Without a descriptor, the existing preview response and routing behavior stays unchanged. The implementation is original Bun host code in `web/src/preview-policy*.ts`; Waffle still owns the preview transport and the page's single Runtime.

## Descriptor

The embedding page sets `globalThis.__bunwasmPreviewPolicy` before importing the playground's main module. `Previews` also accepts the same unknown descriptor as `new Previews({ documentPolicy })`.

```ts
globalThis.__bunwasmPreviewPolicy = {
	contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
	bootstrapURL: new URL("./preview-bootstrap.js", location.href).href,
	hostResourcePaths: ["/preview-bootstrap.js"],
};
```

The example assumes a root-hosted page. A nested application supplies its full canonical resource paths. The descriptor has exactly these three fields:

- `contentSecurityPolicy` is a nonempty valid header value. The consumer chooses the directives its application needs.
- `bootstrapURL` is an absolute canonical same-origin URL without credentials, query or fragment, including empty `?` and `#` suffixes.
- `hostResourcePaths` contains unique canonical absolute paths and includes the bootstrap's pathname. Only exact same-origin GET URLs without a query or fragment bypass guest routing for these resources. Other methods and neighboring paths do not qualify.

`previewWorkerURL` serializes the validated descriptor into the existing service-worker registration URL. A worker restart reads that same descriptor rather than relying on a one-time page message. Absent policy stays absent. An invalid requested policy stays invalid and returns a closed 502 response before preview requests reach a guest; validation does not silently select unconfigured behavior.

## Response behavior

For configured previews, the worker appends the consumer's CSP to existing response policies and adds `nosniff`. UTF-8 HTML gets the bootstrap script after a leading doctype, before the websocket adapter and any guest script. The stream preserves the remaining bytes and propagates cancellation. Decoration removes stale content-length and etag headers. Encoded HTML, XHTML and unsupported document encodings fail closed rather than delivering active content without its bootstrap.

Before browser redirect handling, the worker resolves Location against the requested preview URL. Off-origin 301, 302, 303, 307, and 308 responses become closed 502 responses without Location. Same-origin redirects retain the original response, status, Location, body and guest headers. The unconfigured path does not apply this redirect policy.

## Scoped refusal audit

An embedding page opens a BroadcastChannel before importing the playground's main module. The channel name is `bunwasm-preview-policy:` followed by the exact preview registration scope URL, including its trailing slash. For example, a root-hosted page uses its absolute `./__preview/` URL. The service worker posts this record before returning a refused off-origin redirect:

```ts
{
	type: "bunwasm-preview-policy-refused",
	scope: "https://example.test/__preview/",
	refusal: {
		requestURL: "https://example.test/__preview/43100/page",
		redirectURL: "https://external.test/path",
		method: "GET",
		reason: "Off-origin redirect is forbidden by preview policy",
	},
}
```

The consumer validates incoming records and requires an exact matching scope. Channel messages are observations, not trusted instructions or proof of a successful external request. The consumer retains every valid refusal as a sticky failure for the run, even after navigation succeeds or a later request passes. Opening the listener after main can miss an early refusal. The injected bootstrap separately records browser CSP violations before guest scripts execute.

This descriptor is not a runtime-wide network policy. A consumer still controls and audits guest fetches, offline registry responses and actual external egress independently. A refused redirect or CSP violation must not disappear from a successful application report.

## Verification

`web/tests/preview-policy-config.test.ts` tests descriptor parsing, streams, redirects, response identity and refusal ordering. `web/tests/preview-policy.test.ts` builds the actual classic service worker and exercises its registered handlers. Both run once through the existing Web host test glob. The broad Web quality type project already includes the source and test files. `preview-policy-fixture.ts` is the explicit browser-bundle entry for integration controls; it is not a second Runtime or a Next application acceptance test.
