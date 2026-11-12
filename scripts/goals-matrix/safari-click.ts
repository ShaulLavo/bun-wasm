type ClickArm = { ready: false } | { ready: true; before: string };
type ClickState = {
  token: string;
  target: HTMLButtonElement;
  url: string;
  timeOrigin: number;
  event: { trusted: boolean; target: EventTarget | null } | null;
};
declare global { var __goalsSafariClick: ClickState | undefined; }

export function armSafariClick(input: { button: string; clicked: string; token: string }): ClickArm {
  const target = document.querySelector<HTMLButtonElement>(input.button);
  if (!target || target.disabled) return { ready: false };
  const before = document.querySelector(input.clicked)?.textContent?.trim() ?? "";
  if (!/\b0\b/.test(before)) throw new Error(`Safari counter must start at zero, received ${before}`);
  const state: ClickState = { token: input.token, target, url: location.href, timeOrigin: performance.timeOrigin, event: null };
  globalThis.__goalsSafariClick = state;
  target.addEventListener("click", event => { state.event = { trusted: event.isTrusted, target: event.currentTarget }; }, { once: true, capture: true });
  return { ready: true, before };
}

export function observeSafariClick(input: { button: string; clicked: string; token: string }): { trusted: boolean; after: string } {
  const state = globalThis.__goalsSafariClick;
  if (!state || state.token !== input.token || state.url !== location.href || state.timeOrigin !== performance.timeOrigin) throw new Error("Safari click document changed");
  if (!state.target.isConnected || state.target !== document.querySelector(input.button)) throw new Error("Safari click target changed");
  if (state.event && (!state.event.trusted || state.event.target !== state.target)) throw new Error("Safari click did not deliver a trusted event to the armed target");
  return { trusted: state.event?.trusted === true, after: document.querySelector(input.clicked)?.textContent?.trim() ?? "" };
}
