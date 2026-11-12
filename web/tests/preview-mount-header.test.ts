import { expect, test } from 'bun:test';
import { Previews } from '../src/preview';

test('mounted preview metadata overwrites incoming headers without changing guest request paths', () => {
  for (const baseURL of ['https://example.test/', 'https://example.test/nested/app/', 'https://example.test/my%20app/', 'https://example.test/אפליקציה/']) {
    const previews = new Previews({ baseURL, prefix: '__preview' });
    const headers: [string, string][] = [['X-Bun-Preview-Base', '/forged/'], ['accept', 'text/html']];
    const channel = new MessageChannel();
    previews.register(5173, {
      connect() { return null; },
      request(_port, request) {
        expect(request.target).toBe('/nested?value=1');
        expect(request.headers).toEqual([['accept', 'text/html'], ['x-bun-preview-base', `${new URL(baseURL).pathname}__preview/5173/`]]);
        return false;
      },
    });
    previews.onMessage({ data: { type: 'preview-request', port: 5173, method: 'GET', target: '/nested?value=1', headers, body: null }, ports: [channel.port1] });
    channel.port1.close(); channel.port2.close();
    expect(headers).toEqual([['X-Bun-Preview-Base', '/forged/'], ['accept', 'text/html']]);
  }
});

test('root preview forwarding strips mount metadata', () => {
  const previews = new Previews({ mode: 'root', originForPort: () => 'https://preview.test' });
  const channel = new MessageChannel();
  previews.register(5173, {
    connect() { return null; },
    request(_port, request) {
      expect(request.target).toBe('/');
      expect(request.headers).toEqual([['accept', 'text/html']]);
      return false;
    },
  });
  previews.onMessage({ data: { type: 'preview-request', port: 5173, method: 'GET', target: '/', headers: [['x-bun-preview-base', '/forged/'], ['accept', 'text/html']], body: null }, ports: [channel.port1] });
  channel.port1.close(); channel.port2.close();
});
