// Guest output read back from a browser terminal or from a page's stdout hooks, without colours.
//
// Browser hosts give a guest a terminal for stdout and stderr, so Bun colours non-string console
// values and its `bun test` report there, as native Bun does on a TTY. Harnesses that compare
// that output with plain expected text read it through here.

// SGR sequences only (`ESC [ ... m`): the colours and styles Bun writes. Other control
// sequences, such as cursor movement or screen clears, stay visible to the harness.
// oxlint-disable-next-line no-control-regex -- Matches the ESC that starts each colour sequence.
const SGR = /\u001b\[[0-9;]*m/g;

/** `text` with Bun's colour and style escapes removed. */
export function withoutColors(text: string): string {
  return text.replace(SGR, "");
}
