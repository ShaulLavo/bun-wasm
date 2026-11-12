// One local exported under two names, and a different local with an equal value.
let local = 1;
const other = 1;
export { local as a, local as b, other as c };
export function bump() { local++; }
