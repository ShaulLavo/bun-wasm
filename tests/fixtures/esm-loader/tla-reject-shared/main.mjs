const results = await Promise.allSettled([import('./a.mjs'), import('./b.mjs')]);
console.log(results.map(r => r.status + ':' + (r.reason && r.reason.message)).join(' '));
const [ra, rb] = results;
console.log('same error object', ra.reason === rb.reason);
