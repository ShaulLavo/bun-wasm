interface InitScriptTarget {
  addInitScript(script: () => void): Promise<void>;
}
interface HmrPage {
  waitForFunction(predicate: (selector: string | null) => boolean, selector: string | null, options: { timeout: number }): Promise<unknown>;
}

export async function installHmrConnection(target: InitScriptTarget): Promise<void> {
  await target.addInitScript(() => {
    const info = console.info;
    const warn = console.warn;
    Reflect.set(globalThis, "__testHmrConnected", false);
    console.info = function (...args: unknown[]) {
      if (args[0] === "[Bun] Hot-module-reloading socket connected, waiting for changes..." || args[0] === "[Bun] Reconnected") Reflect.set(globalThis, "__testHmrConnected", true);
      return Reflect.apply(info, console, args);
    };
    console.warn = function (...args: unknown[]) {
      if (args[0] === "[Bun] Hot-module-reloading socket disconnected, reconnecting...") Reflect.set(globalThis, "__testHmrConnected", false);
      return Reflect.apply(warn, console, args);
    };
  });
}

export async function waitForHmrConnection(page: HmrPage, selector: string | null = null, timeout = 20_000): Promise<void> {
  await page.waitForFunction(selector => {
    const target = selector ? document.querySelector<HTMLIFrameElement>(selector)?.contentWindow : globalThis;
    return target !== null && target !== undefined && Reflect.get(target, "__testHmrConnected") === true;
  }, selector, { timeout }).catch(error => {
    throw new Error(`Bun HMR WebSocket did not report connected in ${selector ?? "this page"}`, { cause: error });
  });
}
