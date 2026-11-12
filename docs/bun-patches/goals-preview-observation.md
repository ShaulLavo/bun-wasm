# Preview navigation observations

Classification: original local adapter.

The goals matrix saves a framework source file once, then observes its preview
without navigating it. Astro can legitimately reload that preview. A read-only
`page.evaluate` can lose its execution context during that reload and report a
failed hot-reload phase even when the new document renders the saved text.

The Playwright transport marks render and document-identity reads as observations.
Its existing `waitForFunction` operation survives document replacement at the same
timeout. A serialized primitive result avoids reading an object handle from a
replaced document. The handle is disposed after extraction. Edits, clicks, shell
commands and ordinary evaluations remain one-shot operations. Evaluation errors,
closed pages and missing text remain failures. No arbitrary-error catch,
framework retry, manual navigation or longer deadline is added.

The browser-owned regression runs the actual edit observer with a real document
reload. It also checks missing text, evaluation errors and one-shot command
errors. Safari's transport is unchanged; this adapter does not claim a Safari
navigation fix.

The raw transport now requires finite phase admission, while helpers receive a
bound view that checks each call and bounds its await. Playwright checks again
after closing an old preview or acquiring a new page before switching the active
page or navigating. A page acquired after cancellation remains owned by its
browser for teardown. Observation handle extraction rechecks admission after
`waitForFunction`; disposal remains unconditional. No dispatched page action is
replayed or cancelled merely because its caller stops awaiting it.
