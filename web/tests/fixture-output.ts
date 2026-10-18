export function fixtureOutputPattern(expected: string): RegExp {
  const lines = expected.trim().split("\n").map(line => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(lines.join("[\\s\\S]*?"));
}
