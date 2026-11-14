import { chromium, type Logger } from "playwright";
import { createPageTransport, type Transport } from "./transport";

export async function createChromiumClickFixture(logger: Logger): Promise<Transport> {
  const server = await chromium.launchServer({ headless: true, timeout: 5000, logger });
  const browser = await chromium.connect(server.wsEndpoint()).catch(async error => { await server.close(); throw error; });
  const close = async () => { try { await browser.close(); } finally { await server.close(); } };
  try {
    const context = await browser.newContext({ serviceWorkers: "allow", logger });
    const host = await context.newPage();
    const child = server.process();
    const capabilities = { browserName: "chromium", browserVersion: browser.version(), transport: "playwright", executable: child.spawnfile };
    return { ...createPageTransport(context, host, capabilities, 5000, 5000, close), processRoot: child.pid };
  } catch (error) { await close(); throw error; }
}
