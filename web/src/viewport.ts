/** Keeps the app inside the visible area when the iOS keyboard opens. */
export function followVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const onViewport = () => {
    document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
    if (viewport.offsetTop > 0) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", onViewport);
  viewport.addEventListener("scroll", onViewport);
  onViewport();
}
