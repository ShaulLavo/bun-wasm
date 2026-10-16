import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('plain Node can consume the JS memory helper through the existing host adapters', () => {
  const source = `await import(${JSON.stringify(new URL('../src/subprocess.js', import.meta.url).href)});`;
  const result = spawnSync('node', ['--input-type=module', '-e', source], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

test('module-preparation benchmark links its actual Node host before creating fixtures', () => {
  const result = spawnSync('node', [new URL('../../scripts/bench-module-preparation.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
});

test('browser memory gate source assets still exist after runtime extraction', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const script = new URL('./browser-memory.mjs', import.meta.url);
  const source = readFileSync(script, 'utf8');
  const assets = Array.from(source.matchAll(/readFileSync\(new URL\("([^"]+)", import\.meta\.url\)/g), match => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  for (const path of assets) expect(existsSync(new URL(path, script))).toBe(true);
});
