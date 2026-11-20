// An ES module in TypeScript, loaded with require(). Type-only lines vanish and the enum
// grows when it is compiled, so its compiled lines differ from these.
interface Shape {
  kind: "circle" | "square";
  size: number;
}

type Size = Shape["size"];

enum Unit {
  Px = "px",
  Em = "em",
}

function check(size: Size): Size {
  if (size < 0) throw new RangeError(`negative size: ${size}${Unit.Px}`);
  return size;
}

export function area(shape: Shape): number {
  return check(shape.size) * shape.size;
}
