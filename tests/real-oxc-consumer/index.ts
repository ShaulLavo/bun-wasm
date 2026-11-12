import { parseSync } from 'oxc-parser';
const result = parseSync('input.ts', 'export const answer: number = 42;');
console.log(result.program.body[0].type, result.errors.length);
