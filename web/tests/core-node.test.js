import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('plain Node can consume the JS memory helper through the existing host adapters', () => {
  const source = `await import(${JSON.stringify(new URL('../src/subprocess.js', import.meta.url).href)});`;
  const result = spawnSync('node', ['--input-type=module', '-e', source], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
