interface InitScriptTarget {
  addInitScript(script: () => void): Promise<unknown>;
}
interface HmrPage {
  waitForFunction(predicate: (selector: string | null) => boolean, selector: string | null, options: { timeout: number }): Promise<unknown>;
}

export async function installHmrConnection(target: InitScriptTarget): Promise<void> {
  await target.addInitScript(() => {
    const debug = console.debug;
    const log = console.log;
    Reflect.set(globalThis, "__testHmrConnected", false);
    console.debug = function (...args: unknown[]) {
      if (args[0] === "[vite] connected.") Reflect.set(globalThis, "__testHmrConnected", true);
      return Reflect.apply(debug, console, args);
    };
    console.log = function (...args: unknown[]) {
      if (args[0] === "[vite] server connection lost. Polling for restart...") Reflect.set(globalThis, "__testHmrConnected", false);
      return Reflect.apply(log, console, args);
    };
  });
}

export async function waitForHmrConnection(page: HmrPage, selector: string | null = null, timeout = 20_000): Promise<void> {
  await page.waitForFunction(selector => {
    const target = selector ? document.querySelector<HTMLIFrameElement>(selector)?.contentWindow : globalThis;
    return target !== null && target !== undefined && Reflect.get(target, "__testHmrConnected") === true;
  }, selector, { timeout }).catch(error => {
    throw new Error(`Vite HMR WebSocket did not report connected in ${selector ?? "this page"}`, { cause: error });
  });
}

interface DiagnosticPage {
  url(): string;
  evaluate(read: () => unknown): Promise<unknown>;
}

export async function readHmrFailureState(page: DiagnosticPage, upstream: () => unknown): Promise<unknown> {
  const deadline = Promise.withResolvers<unknown>();
  const timer = setTimeout(deadline.resolve, 2_000, { unavailable: "page did not respond" });
  try {
    const network = upstream();
    const browser = await Promise.race([
      page.evaluate(() => {
        const firstVisit: unknown = Reflect.get(globalThis, "__firstVisit");
        return { readyState: document.readyState, status: document.querySelector("#status")?.textContent, server: document.querySelector("#preview-url")?.textContent, firstVisit };
      }),
      deadline.promise,
    ]);
    return { url: page.url(), network, browser };
  } catch (error) {
    return { url: page.url(), unavailable: String(error) };
  } finally {
    clearTimeout(timer);
  }
}
