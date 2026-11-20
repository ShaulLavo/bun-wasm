// An ES module in TypeScript, loaded with import().
interface Shape {
  kind: "circle" | "square";
  size: number;
}

enum Unit {
  Px = "px",
}

export function area(shape: Shape): number {
  if (shape.size < 0) throw new RangeError(`negative size: ${shape.size}${Unit.Px}`);
  return shape.size * shape.size;
}
