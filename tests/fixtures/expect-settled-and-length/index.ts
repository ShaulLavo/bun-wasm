import { expect } from "bun:test";

// A promise that has already settled is judged on the spot and the matcher returns undefined.
console.log("resolves settled:", expect(Promise.resolve(1)).resolves.toBe(1));
console.log("rejects settled:", expect(Promise.reject("error")).rejects.toBe("error"));
console.log("not resolves settled:", expect(Promise.resolve(1)).resolves.not.toBe(2));

// The awaited form still works, for settled and for later-settled promises.
console.log("awaited resolves:", await expect(Promise.resolve(2)).resolves.toBe(2));
console.log("awaited rejects:", await expect(Promise.reject(new Error("x"))).rejects.toThrow("x"));
const later = new Promise<number>(resolve => setTimeout(() => resolve(3), 1));
console.log("awaited pending:", await expect(later).resolves.toBe(3));

// A settled promise that is the wrong kind throws at once.
for (const [label, run] of [
  ["rejects of a resolved promise", () => expect(Promise.resolve(1)).rejects.toBe(1)],
  ["resolves of a rejected promise", () => expect(Promise.reject(1)).resolves.toBe(1)],
  ["a failing settled match", () => expect(Promise.resolve(1)).resolves.toBe(2)],
] as const) {
  try {
    run();
    console.log(label, "did not throw");
  } catch (error) {
    console.log(label, "threw:", (error as Error).message.split("\n")[0]);
  }
}

// toHaveLength reads the engine's own size for collections, whatever the object shadows.
const check = (label: string, run: () => void) => {
  try {
    run();
    console.log(label, "passes");
  } catch {
    console.log(label, "fails");
  }
};
const form = new FormData();
form.append("a", "1");
form.append("a", "2");
form.append("b", "3");
const blob = new Blob(["abc"]);
Object.defineProperty(blob, "size", {
  get() {
    throw new Error("size");
  },
});
const shadowedForm = new FormData();
shadowedForm.append("a", "1");
Object.defineProperty(shadowedForm, "keys", {
  get() {
    throw new Error("keys");
  },
});
check("map", () => expect(new Map([["x", 1]])).toHaveLength(1));
check("map with a shadowed size", () => expect(Object.defineProperty(new Map([["x", 1]]), "size", { value: 0 })).toHaveLength(1));
check("set", () => expect(new Set([1, 2])).toHaveLength(2));
check("set with a shadowed size", () => expect(Object.defineProperty(new Set([1, 2]), "size", { value: 0 })).toHaveLength(2));
check("headers", () => expect(new Headers({ a: "1" })).toHaveLength(1));
check("form data with repeated names", () => expect(form).toHaveLength(3));
check("form data with a throwing keys", () => expect(shadowedForm).toHaveLength(1));
check("search params", () => expect(new URLSearchParams("a=1&a=2")).toHaveLength(2));
check("blob", () => expect(new Blob(["abcd"])).toHaveLength(4));
check("blob with a throwing size", () => expect(blob).toHaveLength(3));
check("typed array", () => expect(new Uint8Array(4)).toHaveLength(4));
check("array buffer", () => expect(new ArrayBuffer(5)).toHaveLength(5));
check("string", () => expect("abc").toHaveLength(3));
check("own length", () => expect({ length: 2 }).toHaveLength(2));
check("wrong length", () => expect([1]).toHaveLength(2));
check("not wrong length", () => expect([1]).not.toHaveLength(2));
