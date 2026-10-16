const { execFile, execFileSync } = require('node:child_process');
console.log('node sync', execFileSync('node', ['-e', 'console.log(43)'], { encoding: 'utf8' }).trim());
execFile('node', ['-e', 'console.log(42)'], (error, stdout) => {
  if (error) throw error;
  console.log('node async', stdout.trim());
});
