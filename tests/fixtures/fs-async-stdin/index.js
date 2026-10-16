const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', `
  const fs = require('node:fs');
  setTimeout(() => console.log('ready'), 0);
  fs.read(0, Buffer.alloc(10, 'a'), 3, 4, null, (error, count, buffer) => {
    if (error) throw error;
    console.log(count, buffer.toString());
  });
`]);
let output = '';
let replied = false;
child.stdout.on('data', bytes => {
  output += bytes;
  if (!replied && output.includes('ready')) { replied = true; child.stdin.end('ping'); }
});
child.on('close', code => {
  if (code) throw new Error(`child exited ${code}`);
  process.stdout.write(output);
});
