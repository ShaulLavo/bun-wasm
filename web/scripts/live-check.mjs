// Smoke test against a deployed playground: node web/scripts/live-check.mjs <url>
// Runs every example command, Bun.serve + preview, at desktop and iPhone sizes.
// Screenshots go to $SHOTS (default /work/tmp/bun-wasm-shots).
// PLAYWRIGHT=<path to playwright/index.mjs> if it is not resolvable as a package.
const { chromium, webkit, devices } = await import(process.env.PLAYWRIGHT ?? "playwright");
const url = process.argv[2];
const term = async (page) => (await page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "")).replace(/\n/g, "");
async function waitFor(page, re, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await term(page); if (re.test(t)) return t; await page.waitForTimeout(250); }
  throw new Error("timeout waiting for " + re + "\n" + (await term(page)));
}
async function run(page, cmd) {
  await page.click(".xterm");
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
}
for (const [name, type, ctx] of [["desktop-chromium", chromium, { viewport: { width: 1400, height: 900 } }], ["iphone-webkit", webkit, devices["iPhone 15"]]]) {
  const browser = await type.launch();
  const page = await (await browser.newContext(ctx)).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await waitFor(page, /user@bun:~\$/);
  const isolated = await page.evaluate(() => crossOriginIsolated);
  const t0 = Date.now();
  await run(page, "bun run index.ts");
  await waitFor(page, /cwd: \/home\/user/);
  const first = Date.now() - t0;
  await run(page, "bun run jsx.tsx");
  await waitFor(page, /ship it<\/li>/);
  await run(page, "bun run timers.ts");
  await waitFor(page, /slept with Bun.sleep/);
  await run(page, "bun -e 'console.log({ wasm: true, sum: [1,2,3].reduce((a,b)=>a+b) }, Bun.version)'");
  await waitFor(page, /sum: 6/);
  await run(page, "bun test");
  await waitFor(page, /5 pass 0 fail/);
  await run(page, "bun run db.ts");
  await waitFor(page, /open todo/);
  await run(page, "bun build math.ts --outdir out --minify && cat out/math.js");
  await waitFor(page, /export\{n as fib/);
  await run(page, `bun -e 'const s = Bun.serve({ port: 3000, routes: { "/hi/:name": (req) => Response.json({ hello: req.params.name, from: "bun.wasm" }) } }); const r = await fetch(s.url + "hi/phone"); console.log("self-fetch", await r.text())'`);
  await waitFor(page, /self-fetch \{"hello":"phone"/);
  const preview = await page.context().newPage();
  const res = await preview.goto(new URL("__preview/3000/hi/browser", url).href);
  const body = await preview.textContent("body");
  console.log(name, "preview", res.status(), body);
  await preview.close();
  await page.click(".xterm");
  await page.keyboard.press("Control+C");
  await page.screenshot({ path: `${process.env.SHOTS ?? "/work/tmp/bun-wasm-shots"}/live-${name}.png` });
  console.log(name, "status:", await page.textContent("#status"), "isolated:", isolated, "first run ms:", first, "page errors:", errors.length ? errors : "none");
  await browser.close();
}
