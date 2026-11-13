export function computedReaderSource(count: number, name: string): string {
  const names = Array.from({ length: count }, (_, index) => `v${index}`);
  const declarations = names.map((name, index) => `let ${name} = ${index};`).join("");
  const consume = names.map(name => `sum += ${name};`).join("");
  return `function ${name}(holder, key) { ${declarations} let sum = 0; sum += holder[key]; ${consume} return sum; }`;
}

export const computedWidths = [
  { name: "computedNarrow", count: 8, width: "narrow" },
  { name: "computedWide16", count: 2000, width: "wide16" },
  { name: "computedWide32", count: 33000, width: "wide32" },
] as const;
