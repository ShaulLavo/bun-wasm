import early from './hoist.mjs';
// hoist.mjs has not evaluated yet; its anonymous default function already exists.
console.log('early', early(), early.name);
