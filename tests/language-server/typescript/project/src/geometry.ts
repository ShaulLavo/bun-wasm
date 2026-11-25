export interface Point {
  x: number;
  y: number;
}

export function describePoint(point: Point): string {
  return `(${point.x}, ${point.y})`;
}
