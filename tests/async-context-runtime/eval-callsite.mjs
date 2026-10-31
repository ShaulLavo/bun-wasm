export function evaluate(source, storage) {
  void storage;
  // oxlint-disable-next-line no-eval -- Exercise a plain-module lexical call site.
  return eval(source);
}
