/** @jsxRuntime classic */
/** @jsx h */
// An ES module in TSX, loaded with import().
interface Props {
  label: string;
}

function h(tag: string, props: Props | null, ...children: unknown[]) {
  if (children.length > 1) throw new Error(`too many children for <${tag}>`);
  return { tag, props, children };
}

// Not a tail call: JavaScriptCore drops the frames of strict-mode tail calls.
export function render(label: string) {
  const tree = (
    <section label={label}>
      <b>{label}</b>
      <i>{label}</i>
    </section>
  );
  return { tree, label };
}
