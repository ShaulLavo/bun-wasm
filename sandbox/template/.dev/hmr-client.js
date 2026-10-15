// The browser half of dev.ts: React Fast Refresh, CSS swaps, and the build error overlay.
// index.html loads it before the app, so the refresh runtime hooks into React before React loads.

import RefreshRuntime from "react-refresh/runtime";

RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = (type, id) => RefreshRuntime.register(type, id);
window.$RefreshSig$ = () => RefreshRuntime.createSignatureFunctionForTransform();

/** A module failed to build while the page loaded: the app never started, so reload once it's fixed. */
let broken = false;

// ---------- styles ----------

export function updateStyle(id, css) {
  let style = document.querySelector(`style[data-dev-id="${CSS.escape(id)}"]`);
  if (!style) {
    style = document.createElement("style");
    style.dataset.devId = id;
    document.head.append(style);
  }
  style.textContent = css;
}

// ---------- error overlay ----------

const OVERLAY_ID = "__bun_dev_overlay";

export function showErrors(errors, fatal = false) {
  if (fatal) broken = true;
  let overlay = document.getElementById(OVERLAY_ID);
  if (errors.length === 0) {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "alert");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:24px;box-sizing:border-box;" +
      "background:rgba(20,21,26,.94);color:#f3f1ea;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace";
    document.documentElement.append(overlay);
  }
  overlay.replaceChildren(
    ...errors.flatMap(({ file, message }) => {
      const title = document.createElement("div");
      title.textContent = `Build error in ${file}`;
      title.style.cssText = "color:#ff6b6b;font-weight:700;font-size:16px;margin-bottom:8px";
      const pre = document.createElement("pre");
      pre.textContent = message;
      pre.style.cssText = "margin:0 0 20px;white-space:pre-wrap;word-break:break-word;background:#1f2027;padding:12px;border-radius:6px";
      return [title, pre];
    }),
    Object.assign(document.createElement("div"), {
      textContent: "Fix the error and save: this page updates on its own.",
      style: "color:#8d8a84",
    }),
  );
}

// ---------- updates ----------

function isBoundary(mod) {
  const exports = Object.values(mod);
  return exports.length > 0 && exports.every((value) => RefreshRuntime.isLikelyComponentType(value));
}

async function apply(event) {
  switch (event.type) {
    case "reload":
      location.reload();
      return;
    case "css":
      await import(event.url);
      return;
    case "update": {
      if (broken) {
        location.reload();
        return;
      }
      const loaded = await Promise.all(event.modules.map((url) => import(url)));
      if (!loaded.every(isBoundary)) {
        location.reload();
        return;
      }
      RefreshRuntime.performReactRefresh();
      return;
    }
  }
}

async function listen() {
  let since = -1;
  for (;;) {
    try {
      const res = await fetch(`/@hmr/events?since=${since}`, { cache: "no-store" });
      const { id, events, errors } = await res.json();
      since = id;
      for (const event of events) await apply(event);
      if (broken && errors.length === 0 && events.length > 0) location.reload();
      showErrors(errors);
    } catch (err) {
      console.warn("[hmr]", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

void listen();
