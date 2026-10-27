const groups = ["fs", "os", "crypto", "zlib"];

function propertyBehavior(binding: object, name: string, again: () => unknown) {
  const original = Object.getOwnPropertyDescriptor(binding, name);
  if (!original) throw new Error(`Missing constants group ${name}`);
  const replacement = {};
  try {
    const assigned = Reflect.set(binding, name, replacement);
    const assignmentVisible = Reflect.get(binding, name) === replacement;
    const cachedAfterSet = again() === binding && Reflect.get(binding, name) === replacement;
    const deleted = Reflect.deleteProperty(binding, name);
    const deletionVisible = !Object.hasOwn(binding, name) && again() === binding && !Object.hasOwn(binding, name);
    Object.defineProperty(binding, name, { value: replacement, writable: false, enumerable: false, configurable: true });
    const redefined = Object.getOwnPropertyDescriptor(binding, name);
    const readonlySet = Reflect.set(binding, name, {});
    return {
      data: Object.hasOwn(original, "value"),
      writable: original.writable === true,
      enumerable: original.enumerable === true,
      configurable: original.configurable === true,
      accessor: Object.hasOwn(original, "get") || Object.hasOwn(original, "set"),
      assigned, assignmentVisible, cachedAfterSet, deleted, deletionVisible,
      redefined: redefined?.value === replacement && redefined.writable === false && redefined.enumerable === false && redefined.configurable === true,
      readonlySet,
    };
  } finally { Object.defineProperty(binding, name, original); }
}

export function bindingControls(binding: object, again: () => unknown) {
  return {
    prototypeIsNull: Object.getPrototypeOf(binding) === null,
    cachedIdentity: again() === binding,
    properties: Object.fromEntries(groups.map(name => [name, propertyBehavior(binding, name, again)])),
  };
}

export const expectedBinding = {
  prototypeIsNull: true,
  cachedIdentity: true,
  properties: Object.fromEntries(groups.map(name => [name, {
    data: true, writable: true, enumerable: true, configurable: true, accessor: false,
    assigned: true, assignmentVisible: true, cachedAfterSet: true, deleted: true, deletionVisible: true,
    redefined: true, readonlySet: false,
  }])),
};
