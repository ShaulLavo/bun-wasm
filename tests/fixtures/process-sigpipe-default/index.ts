process.kill(process.pid, 'SIGPIPE');
console.log('default ignored');
let handled = false;
process.once('SIGPIPE', () => {
  handled = true;
  console.log('handled');
  process.kill(process.pid, 'SIGPIPE');
});
process.kill(process.pid, 'SIGPIPE');
setTimeout(() => { if (!handled) throw new Error('SIGPIPE handler did not run'); }, 10);
