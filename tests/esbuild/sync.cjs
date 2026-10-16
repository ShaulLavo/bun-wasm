const assert = require('node:assert/strict');
const esbuild = require('esbuild');

try {
  assert.equal(process.env.ESBUILD_WORKER_THREADS, undefined);
  const transformed = esbuild.transformSync('export const value: number = 47;', { loader: 'ts', format: 'esm' });
  assert.match(transformed.code, /47/);
  assert.doesNotMatch(transformed.code, /: number/);
  const built = esbuild.buildSync({ stdin: { contents: 'console.log(48)' }, bundle: true, write: false, metafile: true });
  assert.match(built.outputFiles[0].text, /48/);
  assert.match(esbuild.analyzeMetafileSync(built.metafile), /stdin/);
  assert.match(esbuild.formatMessagesSync([{ text: 'fixture error' }], { kind: 'error', color: false })[0], /fixture error/);
  assert.throws(() => esbuild.transformSync('const =', { loader: 'ts', logLevel: 'silent' }), /Transform failed/);
  assert.throws(() => esbuild.buildSync({ plugins: [{ name: 'sync-plugin', setup() {} }], logLevel: 'silent' }), /Cannot use plugins in synchronous API calls/);
  console.log('esbuild synchronous APIs passed');
} finally { esbuild.stop(); }
