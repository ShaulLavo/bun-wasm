import { expect, test } from 'bun:test';
import { Wasi } from '../core/index';
import { MemFS } from '../../web/src/fs';
const ALL = (1n << 29n) - 1n;
function host(fs = new MemFS(), options = {}) {
  const wasi = new Wasi({ args: [], env: {}, fs, preopens: { '/': '/' }, stdout() {}, stderr() {}, sleep() {}, ...options });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const calls = wasi.functions();
  function open(path, flags = 0) {
    const data = new TextEncoder().encode(path);
    bytes.set(data, 256);
    expect(calls.path_open(3, 0, 256, data.length, flags, ALL, ALL, 0, 1024)).toBe(0);
    return view.getUint32(1024, true);
  }
  return { wasi, memory, view, bytes, calls, open };
}
test('WASI duplicates really share the seek cursor, append flags, and lifetime', () => {
  const fs = new MemFS(); fs.writeFile('/file', 'hello');
  const h = host(fs);
  const fd = h.open('file');
  const dup = h.wasi.descriptors.dup(fd);
  expect(h.calls.fd_seek(dup, 2n, 0, 1024)).toBe(0);
  expect(h.calls.fd_tell(fd, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(2n);
  expect(h.calls.fd_fdstat_set_flags(fd, 1)).toBe(0);
  h.bytes.set(new TextEncoder().encode('!'), 512);
  h.view.setUint32(0, 512, true); h.view.setUint32(4, 1, true);
  expect(h.calls.fd_write(dup, 0, 1, 1024)).toBe(0);
  expect(h.wasi.descriptors.get(fd).resource.offset).toBe(6);
  expect(new TextDecoder().decode(fs.readFile('/file'))).toBe('hello!');
  expect(h.calls.fd_close(fd)).toBe(0);
  expect(h.calls.fd_tell(dup, 1024)).toBe(0);
  expect(h.view.getBigUint64(1024, true)).toBe(6n);
});
test('core uses only the filesystem contract and accepts a zero-valued opaque handle', () => {
  const record = { kind: 'file', ino: 89, size: 4, mtime: 0 };
  const fs = {
    preopen: () => 99, retain() {}, release() {},
    resolve: () => ({ parent: 99, name: 'file', node: 0, trailingSlash: false, terminalDot: false }),
    stat: (handle) => { expect(handle).toBe(0); return record; },
    read: (_handle, chunks) => { chunks[0].set([1, 2, 3, 4]); return 4; },
  };
  const h = host(fs);
  const fd = h.open('file');
  h.view.setUint32(0, 512, true); h.view.setUint32(4, 4, true);
  expect(h.calls.fd_read(fd, 0, 1, 1024)).toBe(0);
  expect(Array.from(h.bytes.subarray(512, 516))).toEqual([1, 2, 3, 4]);
});
test('injected stdio are descriptors with real stream readiness and errno results', () => {
  const state = { readable: false, writable: false, hangup: false };
  const stdin = { kind: 'pipe', read: () => -6, write: () => -64, readiness: () => state };
  const h = host(new MemFS(), { stdio: { 0: stdin } });
  expect(h.wasi.descriptors.get(0).resource).toBe(stdin);
  h.view.setUint32(0, 512, true); h.view.setUint32(4, 1, true);
  expect(h.calls.fd_read(0, 0, 1, 1024)).toBe(6);
  expect(h.calls.fd_write(0, 0, 1, 1024)).toBe(64);
});

test('filesystem handles live once per open description, not once per duplicate', () => {
  const fs = new MemFS(); fs.writeFile('/file', 'data');
  let retains = 0, releases = 0;
  fs.retain = () => retains++;
  fs.release = () => releases++;
  const h = host(fs);
  const fd = h.open('file');
  const dup = h.wasi.descriptors.dup(fd);
  expect(retains).toBe(2); // preopen + one file description
  expect(h.calls.fd_close(fd)).toBe(0);
  expect(releases).toBe(0);
  expect(h.calls.fd_close(dup)).toBe(0);
  expect(releases).toBe(1);
  h.wasi.descriptors.dispose();
  expect(releases).toBe(2);
});
