import { JSONL } from "bun";

const cases = [
  '"a\\u00', '"a\\u', '"a\\u0X00"', '"a\\', '"a\\q"', '"a\n"', '"unfinished',
  '-', '-x', '1.', '1.x', '1e', '1e+', '1e-', '1eX', '1e+2', '1.e2', '01', '-01',
  'true [', 'true 7', 'true\t7\n', 'true\r7', 'true\r\n7', 'true\n7', 'true\n\n7\n',
  'true invalid', 'true\ninvalid', 'true\ninvalid\n', 'true\n{"bad":}',
  '[1,]', '[1,] ', '[1,]\n', 'truX', 'truX ', 'truX\n', 'invalid', 'invalid ',
  '{bad}', '{bad', '{"a":}', '{"a":} ', '{"a"}', '{"a":truX}', '{"a":1e+}',
  '[true false]', '[1 2]', '[true false] ', ']', '] ', ':', '@', '"é"\n[1,]',
  '{', '[', '[1,', '{"a":', 'null\n[', 'null\n[1,]',
  ' \t\r\n', '7 \n ', '"text"{}', '{}{}', '[\n1,\n2\n]\nfalse',
];
function describe(input: string | Uint8Array, start?: number, end?: number) {
  const { values, read, done, error } = JSONL.parseChunk(input, start, end);
  return { values, read, done, error: error ? { name: error.name, message: error.message } : null };
}
for (const text of cases) console.log(JSON.stringify({ text, result: describe(text) }));
for (const text of ['invalid', 'invalid ', '{bad}', '[1,]', '"a\\u00', '1e+', 'true 7']) {
  try { console.log(JSON.stringify({ parse: text, values: JSONL.parse(text) })); }
  catch (error) { console.log(JSON.stringify({ parse: text, error: error instanceof Error ? error.message : String(error) })); }
}
for (const text of ['"é"\n[1,]', '"😀"\n{"bad":}', '"é" 7', '"é"\n7\n']) {
  const bytes = new TextEncoder().encode('\ufeff' + text);
  console.log(JSON.stringify({ bytes: text, result: describe(bytes) }));
  const padded = new Uint8Array(bytes.length + 4);
  padded.set(bytes, 2);
  console.log(JSON.stringify({ view: text, result: describe(padded.subarray(2, -2)) }));
  console.log(JSON.stringify({ slice: text, result: describe(padded, 5, padded.length - 2) }));
}
let pending = '';
const values: unknown[] = [];
for (const chunk of ['{"a":', '1}\n"a\\', 'n"\n[true,', 'false]\n']) {
  pending += chunk;
  const result = JSONL.parseChunk(pending);
  values.push(...result.values);
  pending = pending.slice(result.read);
  console.log(JSON.stringify({ stream: { values: result.values, read: result.read, done: result.done, error: result.error?.message ?? null, pending } }));
}
console.log(JSON.stringify({ streamed: values }));
