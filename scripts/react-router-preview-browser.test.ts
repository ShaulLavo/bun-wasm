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
  const html = await response?.text();
  assert.equal(response?.status(), 200, html ?? 'Missing response');
  assert.ok(html?.includes(`href="${new URL(url).pathname}details"`), 'SSR links must use the browser mount');
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

class RouterPreviewFixture {
  readonly app: string;
  readonly sockets = new Set<Socket>();
  readonly errors: string[] = [];
  browser: Browser | undefined;
  child: ReturnType<typeof Bun.spawn> | undefined;
  bridge: ReturnType<typeof Bun.serve<{ upstream: Socket }>> | undefined;
  owner: ReturnType<typeof Bun.serve> | undefined;
  page: Page | undefined;
  home = '';
  source = '';
  mounted = '';
  direct = '';
  port = 0;
  closing: Promise<void> | undefined;

  constructor(readonly scratch: string) { this.app = join(scratch, 'app'); }

  cleanup(): Promise<void> { return this.closing ??= this.teardown(); }

  private async teardown(): Promise<void> {
    await this.browser?.close();
    this.child?.kill();
    await this.child?.exited;
    for (const socket of this.sockets) socket.destroy();
    await this.bridge?.stop(true);
    await this.owner?.stop(true);
    await rm(this.scratch, { recursive: true, force: true });
  }

  async setup(): Promise<void> {
    await cp(join(root, 'sandbox/template-react-router'), this.app, { recursive: true, filter: path => !path.includes('node_modules') });
    this.home = join(this.app, 'app/routes/home.tsx');
    this.source = (await Bun.file(this.home).text()).replace('useLoaderData,', 'Link, useLoaderData,').replace('<main>', '<main><Link id="details" to="/details">Details</Link><Link id="navigate" to="?value=navigated">Navigate</Link>');
    await Bun.write(this.home, this.source);
    const routes = join(this.app, 'app/routes.ts');
    await Bun.write(routes, (await Bun.file(routes).text()).replace('index,', 'index, route,').replace("index('routes/home.tsx')", "index('routes/home.tsx'), route('details', 'routes/details.tsx')"));
    await Bun.write(join(this.app, 'app/routes/details.tsx'), `import { useLoaderData } from 'react-router';
export function loader() { return 'detail loader'; }
export default function Details() { return <p id="detail-value">{useLoaderData<typeof loader>()}</p>; }`);
    await command([globalThis.process.execPath, 'install'], this.app);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port;
    assert(port);
    this.port = port;
    await reservation.stop(true);
    const sockets = this.sockets;
    this.bridge = Bun.serve<{ upstream: Socket }>({ hostname: '127.0.0.2', port: 0,
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
    const entry = join(root, 'web/tests/browser-react-router-preview-main.ts');
    const built = await Bun.build(browserBuildConfig([entry], this.scratch, { splitting: false }));
    assert(built.success, built.logs.map(String).join('\n'));
    const script = built.outputs[0];
    const socketScript = await previewWebsocketScript();
    const sw = await buildClassicWorker(join(root, 'web/src/sw.ts'), this.scratch, { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(socketScript) });
    const worker = sw.outputs[0];
    assert(script && worker);
    this.owner = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
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
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext();
    context.setDefaultTimeout(timeout);
    const host = await context.newPage();
    host.on('console', message => console.log('owner', message.type(), message.text()));
    host.on('pageerror', error => console.error('owner', error));
    await host.goto(`${this.owner.url}?bridge=${encodeURIComponent(this.bridge.url.href.replace('http:', 'ws:'))}`);
    assert.equal(await host.evaluate(() => Reflect.get(globalThis, 'routerPreviewReady')), 'ready');
    this.page = await context.newPage();
    const page = this.page;
    const errors = this.errors;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' || message.text().includes('No routes matched')) { console.error(message.text()); errors.push(message.text()); } });
    this.mounted = `${this.owner.url.origin}/__preview/5173/`;
    this.direct = `http://127.0.0.1:${port}/`;
  }

  async runMode(mode: 'dev' | 'production'): Promise<void> {
    const { app, port, page, home, source, mounted, direct } = this;
    assert(page);
    const args = mode === 'dev' ? ['node_modules/@react-router/dev/bin.js', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'] : ['start.ts', String(port)];
    this.child = Bun.spawn([globalThis.process.execPath].concat(args), { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env, NODE_ENV: mode === 'dev' ? 'development' : 'production' } });
    assert(this.child.stdout instanceof ReadableStream && this.child.stderr instanceof ReadableStream);
    const log = new Response(this.child.stdout).text();
    const stderr = new Response(this.child.stderr).text();
    await assertServer(direct, this.child);
    await checkBoundary(direct);
    await checkVariants(page, mounted, direct, mode);
    if (mode === 'dev') {
      for (const url of [mounted, direct]) await checkHmr(page, url, home, source, url === mounted);
    }
    await page.goto('about:blank');
    this.child.kill();
    await this.child.exited;
    this.child = undefined;
    console.log(await log, await stderr);
    if (mode === 'dev') await command([globalThis.process.execPath, 'node_modules/@react-router/dev/bin.js', 'build'], app);
  }
}

async function checkBoundary(url: string): Promise<void> {
  for (const mount of ['https://evil.test/', '//evil.test/', '/__preview/0/', '/__preview/65536/', '/__preview/5173/?x=1', '/__preview/5173/#x', '/../__preview/5173/', '/%2e%2e/__preview/5173/', '/my app/__preview/5173/', '/x//__preview/5173/', '/__preview/5173']) {
    const response = await fetch(url, { headers: { 'x-bun-preview-base': mount } });
    assert.equal(response.status, 500, mount);
    await response.body?.cancel();
  }
  for (const mount of ['/nested/app/__preview/1234/', '/my%20app/__preview/5173/', '/%D7%90%D7%A4%D7%9C%D7%99%D7%A7%D7%A6%D7%99%D7%94/__preview/5173/']) {
    const nested = await fetch(url, { headers: { 'x-bun-preview-base': mount } });
    assert.equal(nested.status, 200, `Canonical preview mount must render: ${mount}`);
    assert.ok((await nested.text()).includes(`href="${mount}details"`));
  }
}

async function checkHmr(page: Page, url: string, home: string, source: string, mounted: boolean): Promise<void> {
  const origin = await checkPage(page, url, mounted);
  await Bun.write(home, source.replace('Hello from react-router', 'Hello from react-router hot updated'));
  await page.locator('#message').filter({ hasText: 'Hello from react-router hot updated' }).waitFor();
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'HMR must retain document');
  assert.equal(await page.locator('#count').innerText(), '1', 'HMR must retain counter state');
  console.log(`${mounted ? 'mounted' : 'root'} HMR retained document and counter state`);
  await Bun.write(home, source);
  await page.waitForFunction(() => document.querySelector('#message')?.textContent === 'Hello from react-router');
}

async function checkVariants(page: Page, mounted: string, direct: string, mode: string): Promise<void> {
  for (const [url, isMounted] of [[mounted, true], [direct, false]] as const) {
    const origin = await checkPage(page, url, isMounted);
    await checkNavigation(page, url, origin);
    const link = page.locator('#details');
    assert.equal(await link.getAttribute('href'), `${new URL(url).pathname}details`);
    await link.click();
    await page.waitForURL(`${url}details`);
    await page.locator('#detail-value').filter({ hasText: 'detail loader' }).waitFor();
    assert.equal(await page.evaluate(() => performance.timeOrigin), origin, 'route discovery must retain document');
    await page.goBack();
    await page.locator('#message').waitFor();
    console.log(`${mode} ${isMounted ? 'mounted' : 'root'} render, hydration, click and navigation passed`);
  }
}

test('React Router hydrates, navigates and hot reloads in mounted previews and retains root production behavior', async () => {
  const fixture = new RouterPreviewFixture(await mkdtemp(join(tmpdir(), 'bun-wasm-router-')));
  const onSignal = () => { void fixture.cleanup(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await fixture.setup();
    await fixture.runMode('dev');
    await fixture.runMode('production');
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.cleanup();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
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
