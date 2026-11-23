import { expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { chromium, firefox, webkit } from "playwright";
import { verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(600_000);

// The browser engine validates every SubtleCrypto call in the runtime, as QuickJS and JSC do,
// and computes supported digests, AES and signatures on the browser's own Web Crypto. These
// fixtures cover what the browser lacks or words differently (ChaCha20-Poly1305, ML-KEM,
// ML-DSA, AES-192 on Chromium, Bun's messages), keys sent to a page Worker, and settlement.
const fixtures = [
  "crypto-native-provider", "crypto-vectors", "crypto-native-aes192", "crypto-hmac-required-hash", "crypto-sha1-jwk",
  "crypto-p384-sha1", "webcrypto-chacha20-poly1305", "webcrypto-ml-kem-ml-dsa", "webcrypto-error-messages",
  "webcrypto-key-postmessage", "webcrypto-settlement",
];
const fixtureRoot = resolve(import.meta.dir, "../tests/fixtures");

async function runFixture(page: Page, fixture: string): Promise<void> {
  const folder = join(fixtureRoot, fixture);
  const files = readdirSync(folder).filter(file => /\.(js|ts|json)$/.test(file));
  for (const file of files) await writeFile(page, `/home/user/${fixture}/${file}`, readFileSync(join(folder, file), "utf8"));
  const entry = files.includes("index.ts") ? "index.ts" : "index.js";
  const result = await run(page, `cd /home/user/${fixture} && bun run ${entry}`, 120_000);
  expect(result.code, `${fixture}\n${result.output}`).toBe(0);
  const expected = readFileSync(join(folder, "expected.txt"), "utf8").trim();
  expect(result.output.trim(), fixture).toBe(expected);
}

const browsers = { chromium, firefox, webkit };
const selected = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
for (const name of selected) {
  const type = Object.entries(browsers).find(([key]) => key === name)?.[1];
  if (!type) throw new Error(`Unknown browser: ${name}`);
  test(`${name} runs Bun's WebCrypto on the browser engine`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const root = provided ? join(provided, "site") : resolve(import.meta.dir, "../web/dist");
    const before = provided ? verifySite(provided) : undefined;
    const task = session("bun-wasm-webcrypto-");
    try {
      const [, origin] = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: root, PORT: "0" });
      const browser = await task.launch(type);
      const page = await browser.newPage({ serviceWorkers: "block" });
      await navigateTestPage(page, `${origin}?engine=browser&prompt=off&mode=memory`);
      expect(await ready(page)).toContain("ready · Browser");
      for (const fixture of fixtures) await runFixture(page, fixture);
    } finally { await task.cleanup(); }
    if (provided && before) expect(verifySite(provided)).toEqual(before);
  });
}
