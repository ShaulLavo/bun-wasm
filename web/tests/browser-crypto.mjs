import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {playwright, session, ready, run, writeFile} from "./playground.mjs";
import {firstVisit} from "./first-visit.mjs";
import { navigateTestPage } from "./navigate-test-page.ts";
// The browser engine runs the runtime's own WebCrypto provider, as QuickJS and JSC do, so
// algorithms and messages the host browser lacks (ChaCha20-Poly1305, ML-KEM, ML-DSA, AES-192
// on Chromium, Bun's error text) behave as in Bun in every browser.
const fixtures = [
  "crypto-native-provider", "crypto-vectors", "crypto-native-aes192", "crypto-hmac-required-hash", "crypto-sha1-jwk",
  "crypto-p384-sha1", "webcrypto-chacha20-poly1305", "webcrypto-ml-kem-ml-dsa", "webcrypto-error-messages",
];

async function runFixture(page, name, fixture) {
  const folder = new URL(`../../tests/fixtures/${fixture}/`, import.meta.url);
  const files = readdirSync(folder).filter(file => /\.(js|ts|json)$/.test(file));
  for (const file of files)
    await writeFile(page, `/home/user/${fixture}/${file}`, readFileSync(new URL(file, folder), "utf8"));
  const entry = files.includes("index.ts") ? "index.ts" : "index.js";
  const result = await run(page, `bun run ${fixture}/${entry}`);
  assert.equal(result.code, 0, result.output);
  const expected = readFileSync(new URL("expected.txt", folder), "utf8").trim().split("\n");
  for (const line of expected) assert(result.output.includes(line), `${fixture}: missing ${line}\n${result.output}`);
  console.log(`PASS ${name} ${fixture}`);
}

async function checkBrowser(s, url, name) {
  const browser = await s.launch(playwright[name]);
  const context = await browser.newContext();
  const visit = await firstVisit(context, `${url}?engine=browser&prompt=off`);
  try {
    const page = await context.newPage();
    await navigateTestPage(page, visit.url);
    assert.match(await ready(page), /ready/);
    for (const fixture of fixtures) await runFixture(page, name, fixture);
  } finally {
    await visit.close();
    await browser.close();
  }
}

const s = session("bun-wasm-crypto-browser-");
try {
  const [, url] = await s.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, {PORT:"0"});
  for (const name of ["chromium", "webkit"]) await checkBrowser(s, url, name);
} finally {
  await s.cleanup();
}
