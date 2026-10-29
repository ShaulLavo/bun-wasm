console.log('main start');
const lazy = await import('./lazy.mjs');
console.log('lazy value', lazy.value, lazy.default);
async function later() { return (await import('./lazy.mjs')).value; }
console.log('again', await later());
try { await import('./broken.mjs'); } catch (error) { console.log('broken rejected', error.message); }
try { await import('./broken.mjs'); } catch (error) { console.log('broken again', error.message); }
const spec = './lazy' + '.mjs';
console.log('computed', (await import(spec)).value);
