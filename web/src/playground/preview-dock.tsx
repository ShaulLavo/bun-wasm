import { on, type Handle } from "@remix-run/component";
import type { Playground } from "./playground";
import { copy } from "./showcase-copy";

type Props = { playground: Playground };

/** A server from the examples workspace, shown above the terminal while it listens. */
export function PreviewDock(handle: Handle<Props>) {
  const restart = on<HTMLButtonElement>("click", () => {
    const { playground } = handle.props;
    const demo = playground.activeDemo;
    if (demo) void playground.runDemo(demo).catch(playground.report);
  });
  const close = on<HTMLButtonElement>("click", () => handle.props.playground.closePreview());
  return () => {
    const { playground } = handle.props;
    const preview = playground.dockedPreview;
    if (!preview) return null;
    const label = `localhost:${preview.port}${new URL(preview.url).pathname.endsWith("/") ? "/" : ""}`;
    return (
      <section class="pane preview-dock" aria-label={copy.preview.aria}>
        <div class="bar">
          <span class="live" aria-hidden="true" />
          <span class="preview-address" title={preview.url}>{label}</span>
          {playground.activeDemo
            ? <button type="button" title={copy.preview.restartTitle} disabled={!playground.canStartDemo} mix={restart}>{copy.preview.restart}</button>
            : null}
          <a class="button" href={preview.url} target="_blank" rel="noopener" title={copy.preview.openTitle}>{copy.preview.open}</a>
          <button type="button" title={copy.preview.closeTitle} mix={close}>{copy.preview.close}</button>
        </div>
        <iframe title={copy.preview.frameTitle} src={preview.url} />
      </section>
    );
  };
}
