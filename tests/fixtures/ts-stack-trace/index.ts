interface Shape {
  kind: "circle" | "square";
  size: number;
}

enum Unit {
  Px = "px",
  Em = "em",
}

function area(shape: Shape): number {
  if (shape.kind === "circle") {
    return Math.PI * shape.size ** 2;
  }
  return validate(shape.size) * shape.size;
}

function validate(n: number): number {
  if (n < 0) {
    throw new RangeError(`negative size: ${n}${Unit.Px}`);
  }
  return n;
}

const shapes: Shape[] = [
  { kind: "circle", size: 1 },
  { kind: "square", size: -2 },
];
for (const s of shapes) {
  console.log(area(s).toFixed(2));
}
