const encode = new TextEncoder();
const apply = Reflect.apply;
const add = Set.prototype.add;
const has = Set.prototype.has;
const alphabet = "0123456789abcdef";

export function createStackPrograms(digest: (source: Uint8Array) => Uint8Array) {
  const hashes = new Set<string>();
  return {
    register(source: string) {
      const bytes = digest(encode.encode(source));
      let hash = "";
      for (let index = 0; index < bytes.length; index++) hash += alphabet[bytes[index]! >>> 4]! + alphabet[bytes[index]! & 15]!;
      apply(add, hashes, [hash]);
    },
    has(hash: unknown) { return typeof hash === "string" && apply(has, hashes, [hash]) === true; },
  };
}
