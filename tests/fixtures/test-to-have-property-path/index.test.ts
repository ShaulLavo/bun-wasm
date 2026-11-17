import { expect, test } from "bun:test";

function outcome(run: () => unknown): string {
  try {
    run();
    return "match";
  } catch (error) {
    return error instanceof TypeError ? "TypeError" : (error as Error).message.startsWith("expect(") ? "no match" : (error as Error).message;
  }
}

// Each row: received, path, and the expected value when the row checks one.
const rows: [unknown, string, unknown?][] = [
  [{ a: 1 }, "."], [{ a: 1 }, "]"], [{ a: 1 }, "["], [{ a: 1 }, "[]"], [{ a: 1 }, "[[]]"],
  [{ a: 1 }, ".]"], [{ a: 1 }, ".["], [{ "": 1 }, "[.", 1], [{ a: 1 }, "[."], [{ a: 1 }, "]."],
  [[1], "[0]", 1], [[1], "[0][", 1], [[1], "[0]]", 1], [[1], "[][[[0]", 1], [[1], "[][[[]][[][][.0", 1],
  [[1], "......1.............", 1], [[1], "......0.............", 1], [[1], ".0", 1], [[1], "0.", 1],
  [[{ "": 1 }], "0.", 1], [{ "": { "": 1 } }, ".", 1], [{ "": { "": { "": 1 } } }, "..", 1],
  [{ "": { "": { "": 1 } } }, ".", 1], [{ "": { "": { "": 1 } } }, "...", 1],
  [[1], "0.[[[][][]][[[][[]]]]", 1], [[1], "[0].", 1], [[1], "0", 1], [[1], "[].0", 1], [[1], "].0", 1],
  [[1], "0.[", 1], [[1], "0........[", 1], [[1], "0..[", 1], [[1], "[]..0", 1],
  [[1], "[.][.[[.]]]]].[.[].].]]]]].].].0", 1], [[1], "[.][.[[.]]]]].[.[].].]]0]]].].].", 1],
  [[1], "0      ", 1], [[1], " .[0]", 1], [{ "": 1 }, ".", 1], [{ "": 1 }, "]", 1], [{ "": 1 }, "", 1],
  [{ a: { b: 1 } }, "a.b", 1], [{ a: { b: 1 } }, "a[b]", 1], [{ a: "xy" }, "a.length", 2],
  [Object.create({ a: 1 }), "a", 1], [{ a: null }, "a.b"], [{ a: undefined }, "a.b"],
];

test("string paths follow Bun's lookup", () => {
  for (const [index, [received, path, ...value]] of rows.entries()) {
    console.log(`${index} ${JSON.stringify(path)}: ${outcome(() => expect(received).toHaveProperty(path, ...value))}`);
  }
});

test("array paths and argument checks", () => {
  console.log(outcome(() => expect({ a: { "b.c": 1 } }).toHaveProperty(["a", "b.c"], 1)));
  console.log(outcome(() => expect([[1]]).toHaveProperty([0, 0], 1)));
  console.log(outcome(() => expect({ a: 1 }).toHaveProperty([{}] as never)));
  console.log(outcome(() => expect([1]).toHaveProperty(0 as never)));
  console.log(outcome(() => expect(null).toHaveProperty("a")));
  console.log(outcome(() => expect(undefined).not.toHaveProperty("a")));
});
