let running = true;
function spin() {
  if (running) setImmediate(spin);
}
setImmediate(spin);
await new Promise(resolve => setTimeout(resolve, 5));
running = false;
console.log('Timer progressed');
