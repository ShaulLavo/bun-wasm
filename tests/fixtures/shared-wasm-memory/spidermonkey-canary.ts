function add(left: number, right: number): number { return left + right; }
let sum = 0;
for (let index = 0; index < 200_000; index++) sum = add(sum, index % 7);
console.log(`spidermonkey canary ${sum}`);
