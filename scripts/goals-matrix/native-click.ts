type ClickArm = { ready: false } | { ready: true; before: string };
type ClickState = {
  token: string;
  target: HTMLButtonElement;
  url: string;
  document: Document;
  event: { trusted: boolean; target: EventTarget | null } | null;
};
declare global { var __goalsNativeClick: ClickState | undefined; }

export function armNativeClick(input: { button: string; clicked: string; token: string }): ClickArm {
  const target = document.querySelector<HTMLButtonElement>(input.button);
  if (!target || target.disabled) return { ready: false };
  const before = document.querySelector(input.clicked)?.textContent?.trim() ?? "";
  if (!/\b0\b/.test(before)) throw new Error(`Counter must start at zero, received ${before}`);
  const state: ClickState = { token: input.token, target, url: location.href, document, event: null };
  globalThis.__goalsNativeClick = state;
  target.addEventListener("click", event => { state.event = { trusted: event.isTrusted, target: event.currentTarget }; }, { once: true, capture: true });
  return { ready: true, before };
}

export function observeNativeClick(input: { button: string; clicked: string; token: string }): { trusted: boolean; after: string } {
  const state = globalThis.__goalsNativeClick;
  if (!state) throw new Error("Native click document changed: state-missing; statePresent=false");
  if (state.token !== input.token) throw new Error("Native click document changed: token-mismatch; statePresent=true; tokenEqual=false");
  if (state.url !== location.href) throw new Error("Native click document changed: url-mismatch; statePresent=true; tokenEqual=true; urlEqual=false");
  if (state.document !== document) throw new Error("Native click document changed: document-identity-mismatch; statePresent=true; tokenEqual=true; urlEqual=true; documentEqual=false");
  if (!state.target.isConnected || state.target !== document.querySelector(input.button)) throw new Error("Native click target changed");
  if (state.event && (!state.event.trusted || state.event.target !== state.target)) throw new Error("Native click did not deliver a trusted event to the armed target");
  return { trusted: state.event?.trusted === true, after: document.querySelector(input.clicked)?.textContent?.trim() ?? "" };
}
