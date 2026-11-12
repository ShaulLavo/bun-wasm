import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { browserBuildConfig, buildClassicWorker } from './browser-build';
import { previewWebsocketScript } from '../web/preview-build';

const root = resolve(import.meta.dir, '..');
const timeout = 30_000;

async function command(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stdout + stderr);
}

async function checkPage(page: Page, url: string, mounted: boolean): Promise<number> {
  const response = await page.goto(url);
  assert.equal(response?.status(), 200, await response?.text());
  assert.equal(response?.fromServiceWorker(), mounted);
  await page.waitForFunction(() => document.querySelector('#increment:not([disabled])') || document.body.innerText.includes('404 Not Found'));
  assert.ok(!(await page.locator('body').innerText()).includes('404 Not Found'), await page.locator('body').innerText());
  await page.locator('#increment:not([disabled])').waitFor({ timeout });
  assert.equal(await page.locator('#message').innerText(), 'Hello from react-router');
  await page.locator('#increment').click();
  assert.equal(await page.locator('#count').innerText(), '1');
  return page.evaluate(() => performance.timeOrigin);
}

async function checkNavigation(page: Page, base: string, timeOrigin: number): Promise<void> {
  await page.locator('#navigate').click();
  await page.waitForURL(`${base}?value=navigated`);
  await page.waitForFunction(() => document.querySelector('#server-value')?.textContent === 'navigated');
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'client navigation must retain document');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#server-value')?.textContent === 'initial');
  assert.equal(page.url(), base);
}

test('React Router hydrates, navigates and hot reloads in mounted previews and retains root production behavior', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bun-wasm-router-'));
  const app = join(scratch, 'app');
  let browser: Browser | undefined;
  let process: ReturnType<typeof Bun.spawn> | undefined;
  let bridge: ReturnType<typeof Bun.serve<{ upstream: Socket }>> | undefined;
  let owner: ReturnType<typeof Bun.serve> | undefined;
  const sockets = new Set<Socket>();
  let cleaning: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    return cleaning ??= (async () => {
      await browser?.close();
      process?.kill();
      await process?.exited;
      for (const socket of sockets) socket.destroy();
      await bridge?.stop(true);
      await owner?.stop(true);
      await rm(scratch, { recursive: true, force: true });
    })();
  }
  const onSignal = () => { void cleanup(); };
  globalThis.process.once('SIGTERM', onSignal);
  globalThis.process.once('SIGINT', onSignal);
  try {
    await cp(join(root, 'sandbox/template-react-router'), app, { recursive: true, filter: path => !path.includes('node_modules') });
    const home = join(app, 'app/routes/home.tsx');
    const source = (await Bun.file(home).text()).replace('useLoaderData,', 'Link, useLoaderData,').replace('<main>', '<main><Link id="navigate" to="?value=navigated">Navigate</Link>');
    await Bun.write(home, source);
    await command([globalThis.process.execPath, 'install'], app);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port;
    assert(port);
    await reservation.stop(true);
    bridge = Bun.serve<{ upstream: Socket }>({ hostname: '127.0.0.2', port: 0,
      fetch(request, server) {
        const upstream = connect(port, '127.0.0.1');
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        if (server.upgrade(request, { data: { upstream } })) return;
        upstream.destroy();
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.data.upstream.on('data', data => socket.send(data));
          socket.data.upstream.on('end', () => socket.close());
          socket.data.upstream.on('error', () => socket.close());
        },
        message(socket, data) { socket.data.upstream.write(data); },
        close(socket) { socket.data.upstream.destroy(); },
      },
    });
    const entry = join(root, 'web/tests/react-router-preview-main.ts');
    const built = await Bun.build(browserBuildConfig([entry], scratch, { splitting: false }));
    assert(built.success, built.logs.map(String).join('\n'));
    const script = built.outputs[0];
    const socketScript = await previewWebsocketScript();
    const sw = await buildClassicWorker(join(root, 'web/src/sw.ts'), scratch, { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(socketScript) });
    const worker = sw.outputs[0];
    assert(script && worker);
    owner = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = { 'content-type': 'text/javascript', 'cache-control': 'no-store' };
      if (path.startsWith('/__native/')) {
        const target = new URL(request.url);
        target.pathname = target.pathname.slice('/__native'.length);
        target.host = `127.0.0.1:${port}`;
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.set('accept-encoding', 'identity');
        return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
      }
      if (path === '/sw.js') return new Response(worker, { headers });
      if (path === '/main.js') return new Response(script, { headers });
      if (path === '/preview-websocket.js') return new Response(socketScript, { headers });
      if (path === '/') return new Response('<!doctype html><script type="module" src="/main.js"></script>', { headers: { 'content-type': 'text/html' } });
      return new Response('Preview must be served by the real service worker', { status: 500 });
    } });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.setDefaultTimeout(timeout);
    const host = await context.newPage();
    host.on('console', message => console.log('owner', message.type(), message.text()));
    host.on('pageerror', error => console.error('owner', error));
    await host.goto(`${owner.url}?bridge=${encodeURIComponent(bridge.url.href.replace('http:', 'ws:'))}`);
    assert.equal(await host.evaluate(() => Reflect.get(globalThis, 'routerPreviewReady')), 'ready');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || message.text().includes('No routes matched')) errors.push(message.text()); });
    const mounted = `${owner.url.origin}/__preview/5173/`;
    const direct = `http://127.0.0.1:${port}/`;
    for (const mode of ['dev', 'production']) {
      const args = mode === 'dev' ? ['node_modules/@react-router/dev/bin.js', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'] : ['start.ts', String(port)];
      process = Bun.spawn([globalThis.process.execPath].concat(args), { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, NODE_ENV: mode === 'dev' ? 'development' : 'production' } });
      const log = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      await assertServer(direct, process);
      for (const [url, isMounted] of [[mounted, true], [direct, false]] as const) {
        const origin = await checkPage(page, url, isMounted);
        await checkNavigation(page, url, origin);
        console.log(`${mode} ${isMounted ? 'mounted' : 'root'} render, hydration, click and navigation passed`);
      }
      if (mode === 'dev') {
        const origin = await checkPage(page, mounted, true);
        await Bun.write(home, source.replace('Hello from react-router', 'Hello from react-router hot updated'));
        await page.locator('#message').filter({ hasText: 'Hello from react-router hot updated' }).waitFor();
        assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'HMR must retain document');
        assert.equal(await page.locator('#count').innerText(), '1', 'HMR must retain counter state');
        console.log('mounted HMR retained document and counter state');
        await Bun.write(home, source);
      }
      await page.goto('about:blank');
      process.kill();
      await process.exited;
      process = undefined;
      console.log(await log, await stderr);
      if (mode === 'dev') await command([globalThis.process.execPath, 'node_modules/@react-router/dev/bin.js', 'build'], app);
    }
    assert.deepEqual(errors, []);
  } finally {
    await cleanup();
    globalThis.process.off('SIGTERM', onSignal);
    globalThis.process.off('SIGINT', onSignal);
  }
}, 180_000);

async function assertServer(url: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'React Router server exited early');
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) { await response.body?.cancel(); return; }
    await response?.body?.cancel();
    await Bun.sleep(50);
  }
  throw new Error('React Router server did not start');
}
