const { spawn, spawnSync } = require('node:child_process');
const child = spawn(process.execPath, ['-e', `
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const storage = new AsyncLocalStorage();
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
    fs.readSync(0, first, 0, 1, null);
    fs.read(0, Buffer.alloc(4), { length: 4 }, (error, count, buffer) => {
      if (error) throw error;
      console.log('mixed', first.toString(), buffer.toString('utf8', 0, count));
    });
  `], { input: 'hello', encoding: 'utf8' });
  if (mixed.status) throw new Error(mixed.stderr);
  process.stdout.write(mixed.stdout);
});
