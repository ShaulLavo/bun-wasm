import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { selectAndNavigate } from "./hmr-navigation.ts";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driver = fileURLToPath(new URL("./hmr-check.ts", import.meta.url));

test("a failed initial navigation reports its step and error", async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const child = Bun.spawn(["node", driver, `http://127.0.0.1:${address.port}/`, "--engines", "browser", "--browsers", "chromium"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stdout).toContain("1 of 1 runs failed");
    expect(stdout).toContain("FAIL chromium/browser 0 navigation:");
    expect(stdout.concat(stderr)).toContain("ERR_EMPTY_RESPONSE");
  } finally {
    child.kill();
    await child.exited;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);

test("template navigation waits for the new document even when a subresource stays open", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? "../../web/node_modules/playwright/index.mjs");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (new URL(request.url).pathname === "/pending") return new Response(new ReadableStream());
    const selected = new URL(request.url).searchParams.has("template");
    const html = selected ? '<h1>Vanilla ready</h1><img src="/pending">' : `<select id="template" onchange="if (this.value !== 'stay') location.assign('/?template=' + this.value)"><option>react</option><option>vanilla</option><option>stay</option></select>`;
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await selectAndNavigate(page, "#template", "vanilla", { navigationTimeout: 1_000, actionTimeout: 1_000 });
    await expect(page.locator("h1").textContent()).resolves.toBe("Vanilla ready");
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    await page.goto(server.url.href);
    await expect(selectAndNavigate(page, "#template", "stay", { navigationTimeout: 150, actionTimeout: 150 })).rejects.toThrow("Navigation after selecting #template=stay");
    expect(page.url()).toBe(server.url.href);
    await expect(selectAndNavigate(page, "#template", "missing", { navigationTimeout: 1_000, actionTimeout: 150 })).rejects.toThrow("selectOption");
  } finally {
    try { await browser?.close(); }
    finally { server.stop(true); }
  }
}, 10_000);
