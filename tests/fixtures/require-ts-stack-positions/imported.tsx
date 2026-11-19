/** @jsxRuntime classic */
/** @jsx h */
// An ES module in TSX, loaded with import(). The JSX below compiles to calls, so the
// lines of h after it move when the file is compiled.
interface Props {
  label: string;
}

export function render(label: string) {
  const tree = (
    <section label={label}>
      <b>{label}</b>
      <i>{label}</i>
    </section>
  );
  return { tree, label };
}

function h(tag: string, props: Props | null, ...children: unknown[]) {
  if (children.length > 1) throw new Error(`too many children for <${tag}>`);
  return { tag, props, children };
}
