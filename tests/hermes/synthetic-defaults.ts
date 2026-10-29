const cases: [string, unknown][] = [
  ["null", null], ["undefined", undefined], ["false", false],
  ["zero", 0], ["text", "nonempty text"], ["empty", ""],
];
for (const [name, expected] of cases) {
  const namespace = await import(`./tla/primitive-${name}.cts`);
  console.log("synthetic default", name, Object.is(namespace.default, expected));
}
export {};
