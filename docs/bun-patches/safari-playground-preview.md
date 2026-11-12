# Safari playground preview

Classification: original presentation adapter. No upstream implementation is copied.

The playground keeps registered guest previews in the owning Safari document.
It adapts the repository's header and iframe presentation from
`sandbox/src/preview-pane.tsx` and the in-page arrangement validated by
`scripts/goals-matrix/iphone-browser.ts`, without importing test instrumentation.
Other browsers and ordinary external links keep their existing new-tab behavior.

This keeps the guest's owner visible while the preview loads and runs. Closing
the preview returns to the existing editor and terminal without navigation.
