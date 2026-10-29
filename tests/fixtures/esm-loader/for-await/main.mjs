async function* gen() { yield 'a'; yield 'b'; yield 'c'; }
for await (const item of gen()) console.log('item', item);
for await (const value of [Promise.resolve(1), 2]) console.log('value', value);
const closed = [];
const iterable = { [Symbol.asyncIterator]() { let i = 0; return { next: async () => ({ value: i++, done: false }), return: async () => { closed.push('closed'); return { done: true }; } }; } };
for await (const n of iterable) { if (n === 2) break; }
console.log(closed.join(','));
outer: for await (const x of [1, 2, 3]) { if (x === 2) continue outer; console.log('labeled', x); }
