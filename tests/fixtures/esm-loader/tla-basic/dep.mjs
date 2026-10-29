console.log('dep start');
export let late = 'unset';
export const v = await new Promise(resolve => setTimeout(() => resolve(42), 5));
late = 'set';
console.log('dep end');
