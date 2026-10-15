import type { Terminal } from "@xterm/xterm";

/**
 * Makes `http://localhost:<port>/…` printed in the terminal (Bun.serve's `server.url`, `bun dev`'s
 * "Local:" line) clickable: it opens that guest server's preview in a new tab. The literal localhost
 * URL would point at the visitor's own machine (on a phone, at nothing).
 */
export function linkLocalUrls(
  term: Terminal,
  previews: { serves(port: number): boolean; url(port: number, path?: string): string },
): void {
  const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[^\s'"`)]*)?/g;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = Array.from(text.matchAll(LOCAL_URL))
        .filter((m) => previews.serves(Number(m[1])))
        .map((m) => ({
          text: m[0],
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          activate: () => void window.open(previews.url(Number(m[1]), m[2] ?? "/"), "_blank", "noopener"),
        }));
      callback(links.length > 0 ? links : undefined);
    },
  });
}
