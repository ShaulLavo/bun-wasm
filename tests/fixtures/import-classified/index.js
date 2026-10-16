import { value } from './value.js';
const π = 'UTF-8';
export { value as again } from './value.js';
const obj = { import(x) { return x; } };
const text = 'import(never)';
const template = `import(never) ${obj.import(43)}`;
// import('never')
/* import('never') */
console.log('method', obj?.import(value), { import: 1 }.import);
console.log('syntax', /import\(never\)/.test(text), template);
import(`./${'value'}.js`).then(m => console.log('dynamic', m.value, π));
