const { spawn, spawnSync } = require('node:child_process');
const child = spawn(process.execPath, ['-e', `
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const storage = new AsyncLocalStorage();
  const empty = Buffer.alloc(0);
  assert.equal(fs.readSync(0, empty, 0, 0, null), 0);
  setTimeout(() => console.log('ready'), 0);
  storage.run('stdin', () => fs.read(0, Buffer.alloc(10, 'a'), 3, 4, null, (error, count, buffer) => {
    if (error) throw error;
    assert.equal(storage.getStore(), 'stdin', 'stdin async context');
    console.log(count, buffer.toString());
  }));
`], { stdio: ['pipe', 'pipe', 'inherit'] });
let output = '';
let replied = false;
child.stdout.on('data', bytes => {
  output += bytes;
  if (!replied && output.includes('ready')) { replied = true; child.stdin.end('ping'); }
});
child.on('close', code => {
  if (code) throw new Error(`child exited ${code}`);
  process.stdout.write(output);
  const mixed = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const first = Buffer.alloc(1);
    if (fs.readSync(0, first, 0, 1, null) !== 1) throw new Error('missing first byte');
    const rest = Buffer.alloc(4);
    function readRemaining(offset) {
      fs.read(0, rest, { offset, length: rest.length - offset }, onRead.bind(null, offset));
    }
    function onRead(offset, error, count) {
      if (error) throw error;
      if (count === 0) throw new Error('stdin ended before the buffer was filled');
      const next = offset + count;
      if (next < rest.length) return readRemaining(next);
      console.log('mixed', first.toString(), rest.toString());
    }
    readRemaining(0);
  `], { input: 'hello', encoding: 'utf8' });
  if (mixed.status) throw new Error(mixed.stderr);
  process.stdout.write(mixed.stdout);
});
