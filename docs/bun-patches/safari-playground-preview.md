# Safari playground preview

Classification: original presentation adapter. No upstream implementation is copied.

The playground keeps registered guest previews in the owning Safari document.
It adapts the repository's header and iframe presentation from
`sandbox/src/preview-pane.tsx` and the in-page arrangement validated by
`scripts/goals-matrix/iphone-browser.ts`, without importing test instrumentation.
Other browsers and ordinary external links keep their existing new-tab behavior.

`web/src/playground/preview-links.ts` owns the presentation and the shared
activation callback. `web/src/terminal-links.ts` accepts that callback for raw
localhost links; xterm's OSC8 handler uses it for generated preview links. Only
URLs under a currently registered guest mount or bound guest origin are embedded.
The Safari choice uses the browser's Version/Safari UA tokens and excludes other
browser brands, including Chromium and Firefox on iOS.

This keeps the guest's owner visible while the preview loads and runs. Closing
the preview returns to the existing editor and terminal without navigation.
Reopening the same URL preserves its frame and application state. Replacing a
preview aborts its old listeners and removes its frame. Close, terminal unmount
and non-persisted page teardown remove the owned presentation; a persisted
pagehide preserves it. Close returns focus to the editor. The frame takes focus
once on load when focus is still on the preview control or opening terminal.

`scripts/playground-preview.test.ts`, owned once by the Web browser gate through
`checks/web-browser-playground-preview.json`, bundles the real product opener,
xterm, link provider and stylesheet. Trusted terminal clicks cover both link
sources in Chromium and Linux WebKit, using the captured native Safari UA and a
Chrome UA. Real iframe controls, owner visibility, state, replacement, close,
stale callbacks and teardown are exercised without a guest build. Linux WebKit
is a code guard; it does not qualify a native Safari framework lifecycle.
