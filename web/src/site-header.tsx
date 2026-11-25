import type { Handle } from "@remix-run/component";
import { copy } from "./playground/showcase-copy";

/** The wordmark both pages share: a small prompt mark and "bun.wasm". */
export function SiteBrand() {
  return () => (
    <h1 class="brand">
      <svg class="mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <rect width="20" height="20" rx="4" fill="#fbf0df" />
        <path d="M5.5 6.5 9 10l-3.5 3.5" fill="none" stroke="#14151a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M10.5 14h4" stroke="#f472b6" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span class="wordmark">bun<span class="dim">.wasm</span></span>
    </h1>
  );
}

type NavProps = { current: "sandbox" | "playground"; sandboxHref: string; playgroundHref: string };

/** The two-page switch right after the wordmark; the current page is marked. */
export function SiteNav(handle: Handle<NavProps>) {
  return () => {
    const { current, sandboxHref, playgroundHref } = handle.props;
    const { siteNav } = copy;
    return (
      <nav class="site-nav" aria-label={siteNav.aria}>
        <a class="nav" href={sandboxHref} title={siteNav.sandboxTitle} aria-current={current === "sandbox" ? "page" : undefined}>{siteNav.sandbox}</a>
        <a class="nav" href={playgroundHref} title={siteNav.playgroundTitle} aria-current={current === "playground" ? "page" : undefined}>{siteNav.playground}</a>
      </nav>
    );
  };
}
