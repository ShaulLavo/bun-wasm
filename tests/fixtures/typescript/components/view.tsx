export function render(): string {
  const el = <div className="greeting">Hello {"TSX"}</div>;
  return JSON.stringify(el);
}
