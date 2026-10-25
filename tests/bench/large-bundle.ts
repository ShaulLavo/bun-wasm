import ts from "typescript-api";

const source = ts.createSourceFile("bench.ts", "const value: number = 42;", ts.ScriptTarget.Latest);
if (source.statements.length !== 1) throw new Error("TypeScript compiler did not parse the benchmark source");
console.log(`large-bundle ${ts.version} statements=${source.statements.length}`);
