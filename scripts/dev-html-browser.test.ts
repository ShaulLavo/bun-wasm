import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, type Browser, type Page } from "playwright";
import { counterHtml, developmentPageServer } from "../web/tests/fixtures/dev-html-browser";

type PageServer = Awaited<ReturnType<typeof developmentPageServer>>;
const browsers: Browser[] = [];
beforeAll(async () => {
  try {
    browsers.push(await chromium.launch({ channel: "chromium", headless: true, ignoreDefaultArgs: ["--disable-back-forward-cache"] }));
    browsers.push(await firefox.launch({ headless: true, firefoxUserPrefs: { "browser.sessionhistory.max_total_viewers": 10 } }));
  } catch (error) {
    await Promise.all(browsers.map(browser => browser.close()));
    throw error;
  }
});
afterAll(async () => { await Promise.all(browsers.map(browser => browser.close())); });

async function pageFixture(body: (page: Page, server: PageServer, errors: string[]) => Promise<void>, html = counterHtml): Promise<void> {
  for (const browser of browsers) {
    const server = await developmentPageServer(html);
    let page: Page | undefined;
    try {
      page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(server.url);
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#counter")?.disabled);
      await until(() => server.privateOpened === 1);
      await body(page, server, errors);
    } finally {
      await page?.close();
      await server.close();
    }
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test observation");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function unchanged(page: Page): Promise<void> {
  expect(await page.evaluate(() => {
    const original = Reflect.get(window, "original");
    return original.document === document && original.window === window && original.root === document.documentElement && original.head === document.head && original.body === document.body && original.button === document.querySelector("#counter") && original.value === document.querySelector("#value") && original.url === location.href && Reflect.get(window, "evaluations") === 1;
  })).toBe(true);
}

async function tick(page: Page): Promise<void> {
  // Two actual animation frames delimit observation without a reload or polling client.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("development HTML preserves actual document, roots, listener, counter 0 to 1 to 2 and module evaluation", async () => {
  await pageFixture(async (page, server) => {
    let navigations = 0;
    page.on("framenavigated", () => { navigations++; });
    await page.locator("#counter").click();
    expect(await page.locator("#value").textContent()).toBe("1");
    server.setHtml(counterHtml.replace("Before", "After"));
    server.commit(2);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "After");
    await unchanged(page);
    expect(await page.locator("#value").textContent()).toBe("1");
    expect(await page.locator("#counter").isEnabled()).toBe(true);
    await page.locator("#counter").click();
    expect(await page.locator("#value").textContent()).toBe("2");
    expect(navigations).toBe(0);
    expect(server.rawRequests).toBe(1);
    if (process.env.DEV_HTML_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.DEV_HTML_EVIDENCE_DIR}/counter-${page.context().browser()?.browserType().name()}.png` });
  });
}, 30_000);

test("development HTML never fetches newer bytes without a real committed notice", async () => {
  await pageFixture(async (page, server) => {
    server.setHtml(counterHtml.replace("Before", "Silent"));
    server.unannounced(2);
    await tick(page);
    await tick(page);
    expect(server.rawRequests).toBe(0);
    expect(await page.locator("h1").textContent()).toBe("Before");
    server.commit(2);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Silent");
    await unchanged(page);
  });
}, 30_000);

test("development HTML catches a commit before socket open from the atomic source snapshot", async () => {
  const browser = browsers[0]!;
  const server = await developmentPageServer();
  const page = await browser.newPage();
  try {
    await page.route("**/client.js", async route => {
      server.setHtml(counterHtml.replace("Before", "Already committed"));
      server.commit(2);
      await route.continue();
    });
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Already committed");
    await unchanged(page);
  } finally { await page.close(); await server.close(); }
}, 30_000);

test("development HTML ignores a late obsolete request after a newer commit", async () => {
  await pageFixture(async (page, server) => {
    let release = () => {};
    server.gate(new Promise<void>(resolve => { release = resolve; }));
    server.setHtml(counterHtml.replace("Before", "Old request"));
    server.commit(2);
    await until(() => server.rawRequests === 1);
    server.gate(null);
    server.setHtml(counterHtml.replace("Before", "Newest"));
    server.commit(3);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Newest");
    release();
    await tick(page);
    expect(await page.locator("h1").textContent()).toBe("Newest");
    await unchanged(page);
  });
}, 30_000);

test("development HTML holds an unannounced newer response until its real notice arrives", async () => {
  await pageFixture(async (page, server) => {
    server.commit(2);
    server.setHtml(counterHtml.replace("Before", "Future"));
    server.unannounced(3);
    await until(() => server.rawRequests === 1);
    await tick(page);
    expect(await page.locator("h1").textContent()).toBe("Before");
    server.commit(3);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Future");
    expect(server.rawRequests).toBe(1);
  });
}, 30_000);

for (const [name, candidate] of [
  ["script", counterHtml.replace("/counter.ts", "/different.ts")],
  ["topology", counterHtml.replace("<h1>Before</h1>", "<h1>After<span>new</span></h1>")],
  ["event handler", counterHtml.replace('<h1>', '<h1 onclick="alert(1)">').replace("Before", "After")],
  ["active URL", counterHtml.replace('<button id="counter"', '<button formaction="java\nscript:alert(1)" id="counter"').replace("Before", "After")],
  ["changed ID", counterHtml.replace('id="counter"', 'id="different"').replace("Before", "After")],
  ["duplicate ID", counterHtml.replace('<h1>', '<h1 id="counter">').replace("Before", "After")],
] satisfies [string, string][]) {
  test(`development HTML rejects the whole ${name} patch without changing the page`, async () => {
    await pageFixture(async (page, server, errors) => {
      server.setHtml(candidate);
      server.commit(2);
      await until(() => errors.some(error => /unsupported|conflict|invalid/.test(error)));
      expect(await page.locator("h1").textContent()).toBe("Before");
      await unchanged(page);
      await page.locator("#counter").click();
      expect(await page.locator("#value").textContent()).toBe("1");
    });
  }, 30_000);
}

test("development HTML preflights all conflicts before any heading or attribute write", async () => {
  await pageFixture(async (page, server, errors) => {
    await page.locator("#counter").click();
    server.setHtml(counterHtml.replace("Before", "Must not apply").replace('id="value">0', 'id="value">99'));
    server.commit(2);
    await until(() => errors.some(error => error.includes("conflict")));
    expect(await page.locator("h1").textContent()).toBe("Before");
    expect(await page.locator("#value").textContent()).toBe("1");
    await unchanged(page);
  });
}, 30_000);

test("development HTML preserves unrelated app DOM, focus and form state, and applies safe author fields", async () => {
  const html = counterHtml.replace("<h1>", '<input id="form" value="initial"><img id="image" src="/old.png"><h1>');
  await pageFixture(async (page, server) => {
    await page.locator("#form").fill("typed by user");
    await page.locator("#form").focus();
    await page.evaluate(() => { const aside = document.createElement("aside"); aside.textContent = "runtime"; document.body.appendChild(aside); });
    server.setHtml(html.replace("Before", "Safe fields").replace('/old.png', '/new.png').replace('<title>Counter', '<title>Updated'));
    server.commit(2);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Safe fields");
    expect(await page.locator("#form").inputValue()).toBe("typed by user");
    expect(await page.locator("#form").evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.locator("aside").textContent()).toBe("runtime");
    expect(await page.locator("#image").getAttribute("src")).toBe("/new.png");
    expect(await page.title()).toBe("Updated");
    await unchanged(page);
  }, html);
}, 30_000);

test("development HTML keeps authoritative UTF-8 after the bootstrap moves meta past 1024 bytes", async () => {
  const html = counterHtml.replace("Before", "שלום café 日本語").replace("</head>", `<meta name="padding" content="${"x".repeat(2048)}"></head>`);
  await pageFixture(async (page, server) => {
    expect(await page.locator("h1").textContent()).toBe("שלום café 日本語");
    server.setHtml(html.replace("שלום café 日本語", "עדכון naïve 中文"));
    server.commit(2);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "עדכון naïve 中文");
    await unchanged(page);
  }, html);
}, 30_000);

for (const [name, status, type] of [["500", 500, "text/html"], ["non-HTML", 200, "application/json"], ["redirect", 302, "text/html"]] satisfies [string, number, string][]) {
  test(`development HTML keeps the old DOM after ${name} and recovers on a later real commit`, async () => {
    await pageFixture(async (page, server, errors) => {
      server.rawResponse(status, type);
      server.setHtml(counterHtml.replace("Before", "Recovered"));
      server.commit(2);
      await until(() => errors.length > 0);
      await tick(page);
      expect(server.rawRequests).toBe(1);
      expect(await page.locator("h1").textContent()).toBe("Before");
      server.rawResponse(200);
      server.commit(3);
      await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Recovered");
      await unchanged(page);
    });
  }, 30_000);
}

test("development HTML suspends an open socket before pagehide teardown and restores exactly once", async () => {
  await pageFixture(async (page, server) => {
    await page.locator("#counter").click();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    server.setHtml(counterHtml.replace("Before", "Restored"));
    server.commit(2);
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Restored");
    expect(server.privateOpened).toBe(2);
    expect(await page.locator("#value").textContent()).toBe("1");
    await unchanged(page);
    await page.locator("#counter").click();
    expect(await page.locator("#value").textContent()).toBe("2");
  });
}, 30_000);

test("development HTML terminal disconnect prevents later commits, reads or duplicate subscriptions", async () => {
  await pageFixture(async (page, server, errors) => {
    await page.evaluate(() => {
      const Base = window.MessageChannel;
      const closed: number[] = [];
      Reflect.set(window, "disconnectChannels", closed);
      window.MessageChannel = class extends Base {
        constructor() {
          super();
          const index = closed.push(0) - 1;
          for (const port of [this.port1, this.port2]) {
            const close = port.close.bind(port);
            port.close = () => { closed[index] = (closed[index] ?? 0) + 1; close(); };
          }
        }
      };
    });
    server.source.close();
    await until(() => errors.some(error => error.includes("disconnected")));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await tick(page);
    expect(server.privateOpened).toBe(1);
    expect(errors.filter(error => error.includes("disconnected"))).toHaveLength(1);
    expect(await page.evaluate(() => Reflect.get(window, "disconnectChannels"))).toEqual([2]);
    expect(server.rawRequests).toBe(0);
    await unchanged(page);
  });
}, 30_000);

test("development HTML runs the exact unchanged Hono page and counter source once", async () => {
  const html = await Bun.file(new URL("../sandbox/template-hono/src/page.html", import.meta.url)).text();
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(new URL("../sandbox/template-hono/counter.ts", import.meta.url)).text());
  const observe = `\nwindow.evaluations = (window.evaluations || 0) + 1; window.original = {document, window, root: document.documentElement, head: document.head, body: document.body, button: document.querySelector('#increment'), value: document.querySelector('#count'), url: location.href};`;
  for (const browser of browsers) {
    const server = await developmentPageServer(html, script + observe);
    const page = await browser.newPage();
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#increment")?.disabled);
      await until(() => server.privateOpened === 1);
      await page.locator("#increment").click();
      expect(await page.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("1");
      server.setHtml(html.replace("Hello from hono", "Edited Hono heading"));
      server.commit(2);
      await page.waitForFunction(() => document.querySelector("#message")?.textContent === "Edited Hono heading");
      expect(await page.evaluate(() => {
        const before = Reflect.get(window, "original");
        return before.document === document && before.window === window && before.root === document.documentElement && before.head === document.head && before.body === document.body && before.button === document.querySelector("#increment") && before.value === document.querySelector("#count") && Reflect.get(window, "evaluations") === 1;
      })).toBe(true);
      expect(await page.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("1");
      await page.locator("#increment").click();
      expect(await page.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("2");
    } finally { await page.close(); await server.close(); }
  }
}, 30_000);

test("development HTML survives real SW connecting teardown before its Window-target pagehide listener", async () => {
  const { previewSocketShim } = await import("../web/tests/fixtures/dev-html-browser");
  const shim = await previewSocketShim() + `
const Base = window.WebSocket; window.testSockets = []; window.WebSocket = class extends Base { constructor(...args) { super(...args); window.testSockets.push(this); } };`;
  for (const browser of browsers) {
    const server = await developmentPageServer(counterHtml, undefined, shim);
    const page = await browser.newPage();
    const messages: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("console", message => messages.push(message.text()));
    page.on("pageerror", error => messages.push(error.message));
    try {
      await page.addInitScript(() => {
        const ports: MessagePort[] = [];
        Reflect.set(window, "testPorts", ports);
        Object.defineProperty(navigator, "serviceWorker", { value: { controller: { postMessage(_message: unknown, transferred: MessagePort[]) {
          const port = transferred[0]!;
          ports.push(port);
          port.onmessage = async event => {
            if (event.data.type !== "data" || ports.length === 1) return;
            const text = new TextDecoder().decode(event.data.chunk);
            if (!text.startsWith("GET ")) return;
            const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(text)?.[1];
            const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            const accept = btoa(String.fromCharCode(...new Uint8Array(hash)));
            const reply = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
            port.postMessage({ type: "data", chunk: new TextEncoder().encode(reply) });
          };
          port.start();
        } } } });
      });
      await page.goto(server.url);
      await page.waitForFunction(() => Reflect.get(window, "testPorts").length === 1);
      await page.locator("#counter").click();
      await page.evaluate(() => {
        const socket = Reflect.get(window, "testSockets")[0];
        Reflect.set(window, "oldDevMessage", socket.onmessage);
        Reflect.set(window, "oldDevError", socket.onerror);
      });
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      server.setHtml(counterHtml.replace("Before", "After pending handshake"));
      server.commit(2);
      await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
      await page.waitForFunction(() => Reflect.get(window, "testPorts").length === 2);
      await page.waitForFunction(() => Reflect.get(window, "testSockets")[1]?.readyState === 1);
      await page.evaluate(() => {
        Reflect.get(window, "oldDevMessage")(new MessageEvent("message", { data: "old malformed frame" }));
        Reflect.get(window, "oldDevError")(new Event("error"));
      });
      await page.evaluate(async stamp => {
        const port: MessagePort = Reflect.get(window, "testPorts")[1];
        const data = new TextEncoder().encode(JSON.stringify({ kind: "committed", stamp }));
        const bytes = new Uint8Array(data.length + 2);
        bytes[0] = 0x81; bytes[1] = data.length; bytes.set(data, 2);
        port.postMessage({ type: "data", chunk: bytes });
      }, server.stamp);
      await page.waitForFunction(() => document.querySelector("h1")?.textContent === "After pending handshake");
      expect(await page.evaluate(() => Reflect.get(window, "testPorts").length)).toBe(2);
      await unchanged(page);
      expect(await page.locator("#value").textContent()).toBe("1");
      await page.locator("#counter").click();
      expect(await page.locator("#value").textContent()).toBe("2");
    } catch (error) { console.error(messages, await page.evaluate(() => ({ ports: Reflect.get(window, "testPorts").length, marker: document.documentElement.getAttribute("data-bun-wasm-dev") }))); throw error; }
    finally { await page.close(); await server.close(); }
  }
}, 30_000);

test("development HTML records genuine nonpersisted lifecycle and conditionally checks browser-permitted bfcache", async () => {
  const { previewSocketShim } = await import("../web/tests/fixtures/dev-html-browser");
  const shim = await previewSocketShim() + `\nconst Base = window.WebSocket; window.testSockets = []; window.WebSocket = class extends Base { constructor(...args) { super(...args); window.testSockets.push(this); } };`;
  const observations: unknown[] = [];
  for (const browser of browsers) {
    const server = await developmentPageServer(counterHtml, undefined, shim);
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const bfcache: unknown[] = [];
    const cdp = browser.browserType().name() === "chromium" ? await page.context().newCDPSession(page) : null;
    if (cdp) { await cdp.send("Page.enable"); cdp.on("Page.backForwardCacheNotUsed", value => bfcache.push(value)); }
    try {
      await page.addInitScript(() => {
        const id = crypto.randomUUID();
        Reflect.set(window, "documentIdentity", id);
        const events: { type: string; persisted: boolean; trusted: boolean; id: string }[] = [];
        const record = (event: PageTransitionEvent) => {
          events.push({ type: event.type, persisted: event.persisted, trusted: event.isTrusted, id });
          const previous = JSON.parse(sessionStorage.getItem("devHtmlLifecycle") ?? "[]");
          previous.push(events.at(-1));
          sessionStorage.setItem("devHtmlLifecycle", JSON.stringify(previous));
        };
        window.addEventListener("pagehide", record, true);
        window.addEventListener("pageshow", record, true);
        const ports: MessagePort[] = [];
        Reflect.set(window, "testPorts", ports);
        Object.defineProperty(navigator, "serviceWorker", { value: { controller: { postMessage(_message: unknown, transferred: MessagePort[]) {
          const port = transferred[0]!;
          ports.push(port);
          port.postMessage({ type: "accepted" });
          port.onmessage = async event => {
            if (event.data.type !== "data" || ports.length === 1) return;
            const text = new TextDecoder().decode(event.data.chunk);
            if (!text.startsWith("GET ")) return;
            const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/i.exec(text)?.[1];
            const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            const accept = btoa(String.fromCharCode(...new Uint8Array(hash)));
            port.postMessage({ type: "data", chunk: new TextEncoder().encode(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`) });
          };
          port.start();
        } } } });
      });
      await page.goto(server.url);
      await page.waitForFunction(() => Reflect.get(window, "testPorts").length === 1);
      await page.locator("#counter").click();
      const original = await page.evaluate(() => Reflect.get(window, "documentIdentity"));
      await page.goto(`${server.url}away`);
      const hidden = await page.evaluate(() => JSON.parse(sessionStorage.getItem("devHtmlLifecycle") ?? "[]"));
      expect(hidden.some((event: { type: string; trusted: boolean; id: string }) => event.type === "pagehide" && event.trusted && event.id === original)).toBe(true);
      server.setHtml(counterHtml.replace("Before", "After native lifecycle"));
      server.commit(2);
      await page.goBack();
      await page.waitForFunction(() => Reflect.get(window, "testPorts")?.length > 0);
      const history: { type: string; persisted: boolean; trusted: boolean; id: string }[] = await page.evaluate(() => JSON.parse(sessionStorage.getItem("devHtmlLifecycle") ?? "[]"));
      const restored = history.some(event => event.type === "pageshow" && event.persisted && event.id === original);
      observations.push({ browser: browser.browserType().name(), restored, events: history, bfcache, errors });
      if (!restored) {
        expect(await page.evaluate(() => Reflect.get(window, "documentIdentity"))).not.toBe(original);
        continue;
      }
      expect(await page.evaluate(() => Reflect.get(window, "documentIdentity"))).toBe(original);
      await page.waitForFunction(() => Reflect.get(window, "testSockets")[1]?.readyState === 1);
      await page.evaluate(stamp => {
        const data = new TextEncoder().encode(JSON.stringify({ kind: "committed", stamp }));
        const frame = new Uint8Array(data.length + 2);
        frame[0] = 0x81; frame[1] = data.length; frame.set(data, 2);
        Reflect.get(window, "testPorts")[1].postMessage({ type: "data", chunk: frame });
      }, server.stamp);
      await page.waitForFunction(() => document.querySelector("h1")?.textContent === "After native lifecycle");
      expect(await page.evaluate(() => Reflect.get(window, "testSockets").length)).toBe(2);
      expect(await page.locator("#value").textContent()).toBe("1");
      await unchanged(page);
      await page.locator("#counter").click();
      expect(await page.locator("#value").textContent()).toBe("2");
    } finally { await cdp?.detach(); await page.close(); await server.close(); }
  }
  if (process.env.DEV_HTML_EVIDENCE_DIR) await Bun.write(`${process.env.DEV_HTML_EVIDENCE_DIR}/native-lifecycle.json`, JSON.stringify(observations, null, 2));
}, 30_000);

test("development HTML ignores duplicate and old socket notices without a GET", async () => {
  await pageFixture(async (page, server) => {
    server.frame(JSON.stringify({ kind: "committed", stamp: server.stamp }));
    await tick(page);
    expect(server.rawRequests).toBe(0);
    server.setHtml(counterHtml.replace("Before", "Revision three"));
    server.commit(3);
    await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Revision three");
    server.frame(JSON.stringify({ kind: "committed", stamp: { ...server.stamp, revision: 2 } }));
    server.frame(JSON.stringify({ kind: "committed", stamp: server.stamp }));
    await tick(page);
    expect(server.rawRequests).toBe(1);
  });
}, 30_000);

for (const frame of ["{bad", JSON.stringify({ kind: "committed", stamp: { server: "foreign", revision: 100 } })]) {
  test("development HTML rejects malformed or foreign socket frames without binding another server", async () => {
    await pageFixture(async (page, server, errors) => {
      server.frame(frame);
      await until(() => errors.length > 0);
      server.setHtml(counterHtml.replace("Before", "Must not apply"));
      server.commit(2);
      await tick(page);
      expect(await page.locator("h1").textContent()).toBe("Before");
      expect(server.rawRequests).toBe(0);
      await unchanged(page);
    });
  }, 30_000);
}

test("development HTML rolls back earlier writes when a later DOM operation throws", async () => {
  await pageFixture(async (page, server, errors) => {
    await page.evaluate(() => {
      const set = Element.prototype.setAttributeNS;
      Element.prototype.setAttributeNS = function(namespace, name, value) {
        if (name === "class" && value === "throw-once") { Element.prototype.setAttributeNS = set; throw new Error("test DOM failure"); }
        return set.call(this, namespace, name, value);
      };
    });
    server.setHtml(counterHtml.replace("<title>Counter", "<title>Changed title").replace("<h1>", '<h1 class="throw-once">').replace("Before", "Changed heading"));
    server.commit(2);
    await until(() => errors.some(error => error.includes("test DOM failure")));
    expect(await page.title()).toBe("Counter");
    expect(await page.locator("h1").textContent()).toBe("Before");
    await unchanged(page);
  });
}, 30_000);

test("development HTML keeps two documents subscribed independently and closes only their private sockets", async () => {
  const server = await developmentPageServer();
  const pages: Page[] = [];
  try {
    for (const browser of browsers) pages.push(await browser.newPage());
    for (const page of pages) await page.goto(server.url);
    await until(() => server.socketCount === pages.length);
    server.setHtml(counterHtml.replace("Before", "Both documents"));
    server.commit(2);
    for (const page of pages) await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Both documents");
    await pages[0]!.close();
    await until(() => server.socketCount === pages.length - 1);
    server.setHtml(counterHtml.replace("Before", "Remaining document"));
    server.commit(3);
    await pages[1]!.waitForFunction(() => document.querySelector("h1")?.textContent === "Remaining document");
    await unchanged(pages[1]!);
  } finally { for (const page of pages) await page.close(); await server.close(); }
}, 30_000);

const integratedSite = process.env.BUN_WASM_DEV_HTML_SITE;
test.skipIf(!integratedSite)("actual Waffle filesystem commit updates the same running HTML document", async () => {
  if (!integratedSite) throw new Error("Provide the matching current-source development site");
  const { verifySite } = await import("./browser-guest-site");
  const { ready, session, terminalText, writeFile } = await import("../web/tests/playground.mjs");
  const { stopForeground } = await import("../web/tests/foreground");
  const { resolve, join } = await import("node:path");
  const directory = resolve(integratedSite);
  const before = verifySite(directory);
  const previousRoot = process.env.ROOT;
  const task = session("bun-wasm-dev-html-actual-");
  let app: Page | undefined;
  let preview: Page | undefined;
  const evidence: unknown[] = [];
  try {
    process.env.ROOT = join(directory, "site");
    const url = await task.serve();
    const browser = await task.launch(chromium);
    app = await browser.newPage();
    await app.goto(`${url}?engine=browser&prompt=off&mode=memory`);
    expect(await ready(app)).toContain("ready");
    const html = await Bun.file(new URL("../sandbox/template-hono/src/page.html", import.meta.url)).text();
    const counter = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(new URL("../sandbox/template-hono/counter.ts", import.meta.url)).text());
    const entry = `import html from "./page.html" with {type:"text"};
const state = globalThis.actualHtmlServer ??= {runs:0, server:null};
const run = ++state.runs;
const server = Bun.serve({hostname:"127.0.0.1",port:5173,fetch(request) {
  if (new URL(request.url).pathname === "/counter.ts") return new Response(${JSON.stringify(counter)},{headers:{"content-type":"text/javascript"}});
  return new Response(html,{headers:{"content-type":"text/html","x-dev-pid":String(process.pid),"x-dev-run":String(run),"x-dev-same-server":String(server===state.server)}});
}}); state.server ??= server;`;
    await writeFile(app, "/home/user/page.html", html);
    await writeFile(app, "/home/user/server.ts", entry);
    await app.evaluate(() => {
      const value: unknown = Reflect.get(globalThis, "playground");
      if (!value || typeof value !== "object" || !("shell" in value)) throw new Error("Missing shell");
      const shell = value.shell;
      if (!shell || typeof shell !== "object" || !("submit" in shell) || typeof shell.submit !== "function") throw new Error("Missing shell submit");
      void shell.submit("bun --hot run server.ts");
    });
    const listening = await app.waitForFunction(() => {
      const value: unknown = Reflect.get(globalThis, "playground");
      if (!value || typeof value !== "object" || !("previews" in value)) return null;
      const previews = value.previews;
      if (!previews || typeof previews !== "object" || !("serves" in previews) || typeof previews.serves !== "function" || !("url" in previews) || typeof previews.url !== "function") return null;
      if (!previews.serves(5173)) return null;
      const url = previews.url.bind(previews);
      return Promise.resolve(Reflect.get(previews, "ready")).then(state => state === "ready" ? url(5173) : null);
    }, undefined, { timeout: 60_000 });
    const previewUrl: unknown = await listening.jsonValue();
    await listening.dispose();
    if (typeof previewUrl !== "string") throw new Error("Missing actual listener URL");
    preview = await app.context().newPage();
    await preview.addInitScript(() => {
      const observed: { kind: string; value: unknown; time: number }[] = [];
      Reflect.set(window, "actualDevEvents", observed);
      const define = Object.defineProperty;
      Object.defineProperty = function(target, key, descriptor) {
        if (target === window && key === "WebSocket" && typeof descriptor.value === "function") {
          const Socket = descriptor.value;
          descriptor = { ...descriptor, value: class extends Socket {
            constructor(...args: unknown[]) {
              super(...args);
              this.addEventListener("message", (event: MessageEvent) => observed.push({ kind: "notice", value: event.data, time: performance.now() }));
            }
          } };
        }
        return define(target, key, descriptor);
      };
      const fetch = window.fetch;
      window.fetch = Object.assign(async function(input: RequestInfo | URL, init?: RequestInit) {
        if (new Headers(init?.headers).get("x-bun-wasm-dev-raw") === "1") observed.push({ kind: "GET", value: String(input), time: performance.now() });
        const response = await fetch(input, init);
        const stamp = response.headers.get("x-bun-wasm-dev-stamp");
        if (stamp) observed.push({ kind: "response", value: { stamp, pid: response.headers.get("x-dev-pid"), run: response.headers.get("x-dev-run"), same: response.headers.get("x-dev-same-server") }, time: performance.now() });
        return response;
      }, fetch);
    });
    const initial = await preview.goto(previewUrl);
    if (!initial) throw new Error("Missing initial preview response");
    const initialHeaders = await initial.allHeaders();
    const pid = initialHeaders["x-dev-pid"];
    expect(pid).toBeTruthy();
    expect(initialHeaders["x-dev-same-server"]).toBe("true");
    await preview.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#increment")?.disabled);
    await preview.evaluate(() => {
      Reflect.set(window, "actualIdentity", { document, window, root: document.documentElement, head: document.head, body: document.body, button: document.querySelector("#increment"), output: document.querySelector("#count"), url: location.href });
      new MutationObserver(() => {
        Reflect.get(window, "actualDevEvents").push({ kind: "DOM", value: document.querySelector("#message")?.textContent, time: performance.now() });
      }).observe(document.querySelector("#message")!, { subtree: true, childList: true, characterData: true });
    });
    await preview.locator("#increment").click();
    expect(await preview.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("1");
    let navigations = 0;
    preview.on("framenavigated", () => { navigations++; });
    await writeFile(app, "/home/user/page.html", html.replace("Hello from hono", "Actual Waffle update"));
    await preview.waitForFunction(() => document.querySelector("#message")?.textContent === "Actual Waffle update", undefined, { timeout: 30_000 });
    expect(await preview.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("1");
    expect(await preview.evaluate(() => {
      const old = Reflect.get(window, "actualIdentity");
      return old.document === document && old.window === window && old.root === document.documentElement && old.head === document.head && old.body === document.body && old.button === document.querySelector("#increment") && old.output === document.querySelector("#count") && old.url === location.href;
    })).toBe(true);
    await preview.locator("#increment").click();
    expect(await preview.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("2");
    const events: { kind: string; value: unknown; time: number }[] = await preview.evaluate(() => Reflect.get(window, "actualDevEvents"));
    const get = events.findIndex(event => event.kind === "GET");
    const notice = events.findIndex(event => event.kind === "notice");
    const response = events.findIndex(event => event.kind === "response");
    const dom = events.findIndex(event => event.kind === "DOM");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(get).toBeGreaterThan(notice);
    expect(response).toBeGreaterThan(get);
    expect(dom).toBeGreaterThan(response);
    expect(JSON.stringify(events[response]?.value)).toContain(`"pid":"${pid}"`);
    expect(JSON.stringify(events[response]?.value)).toContain('"same":"true"');
    expect(navigations).toBe(0);
    await writeFile(app, "/home/user/server.ts", "const invalid = ;");
    const terminal = app;
    await until(async () => (await terminalText(terminal)).includes("SyntaxError"));
    expect(await preview.locator("#message").textContent()).toBe("Actual Waffle update");
    await writeFile(app, "/home/user/page.html", html.replace("Hello from hono", "Repaired Waffle update"));
    await writeFile(app, "/home/user/server.ts", entry);
    await preview.waitForFunction(() => document.querySelector("#message")?.textContent === "Repaired Waffle update", undefined, { timeout: 30_000 });
    expect(await preview.locator("#count").evaluate(node => Reflect.get(node, "value"))).toBe("2");
    evidence.push({ pid, initialHeaders, events, repairedEvents: await preview.evaluate(() => Reflect.get(window, "actualDevEvents")), terminal: await terminalText(app) });
    expect(verifySite(directory)).toEqual(before);
  } finally {
    if (process.env.DEV_HTML_EVIDENCE_DIR) await Bun.write(`${process.env.DEV_HTML_EVIDENCE_DIR}/actual-waffle.json`, JSON.stringify(evidence, null, 2));
    if (app) await stopForeground(app).catch(() => {});
    await preview?.close();
    await app?.close();
    await task.cleanup();
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
  }
}, 300_000);
