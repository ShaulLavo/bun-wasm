import { StringDecoder } from "node:string_decoder";
import util from "node:util";

// StringDecoder works as an ES5 constructor: called, applied to a receiver,
// subclassed and constructed with another new.target.
const Decoder = StringDecoder as unknown as {
  (this: unknown, encoding?: string): StringDecoder;
  new (encoding?: string): StringDecoder;
  prototype: StringDecoder;
  name: string;
  length: number;
};

console.log("shape", typeof Decoder, Decoder.name, Decoder.length, Decoder.prototype.constructor === Decoder);

const called = [Decoder("utf8"), Decoder.call(undefined, "utf8"), Decoder.call("x", "hex")];
console.log("called", called.map(decoder => `${decoder instanceof StringDecoder}:${decoder.encoding}`).join(" "));
console.log("called write", called[0].write(Buffer.from("hi")), called[2].write(Buffer.from([0xab])));

function Legacy(this: StringDecoder, encoding: string) {
  Decoder.apply(this, [encoding]);
}
util.inherits(Legacy, Decoder as unknown as Function);
const legacy = new (Legacy as unknown as new (encoding: string) => StringDecoder)("utf8");
console.log("es5 subclass", legacy instanceof Legacy, legacy instanceof StringDecoder, legacy.encoding);
console.log("es5 write", JSON.stringify(legacy.write(Buffer.from([0xe2, 0x82]))), legacy.write(Buffer.from([0xac])), JSON.stringify(legacy.end()));

class Sub extends StringDecoder {
  chunks = 0;
  label: string;
  constructor(encoding: BufferEncoding, label: string) {
    super(encoding);
    this.label = label;
  }
  write(buffer: Buffer): string {
    this.chunks++;
    return super.write(buffer);
  }
}
const sub = new Sub("utf16le", "wide");
console.log("class subclass", sub instanceof Sub, Object.getPrototypeOf(sub) === Sub.prototype, sub.encoding, sub.write(Buffer.from("hi", "utf16le")), sub.label, sub.chunks);
console.log("class keys", Reflect.ownKeys(Sub).map(String).join(","));

function Unrelated() {}
const other = Reflect.construct(StringDecoder, ["latin1"], Unrelated) as StringDecoder;
console.log("new.target", Object.getPrototypeOf(other) === Unrelated.prototype, Object.hasOwn(Unrelated, "encoding"), Decoder.prototype.write.call(other, Buffer.from([0xe9])));
const plain = Reflect.construct(StringDecoder, ["utf8"], Object) as StringDecoder;
console.log("Object new.target", Object.getPrototypeOf(plain) === Object.prototype, Object.hasOwn(Object, "encoding"), Decoder.prototype.write.call(plain, Buffer.from("ok")));
const proxied = Reflect.construct(StringDecoder, ["utf8"], new Proxy(Sub, {}));
console.log("proxy new.target", proxied instanceof Sub);
const { proxy, revoke } = Proxy.revocable(Sub, {});
revoke();
try {
  Reflect.construct(StringDecoder, ["utf8"], proxy);
  console.log("revoked returned");
} catch (error) {
  console.log("revoked throws", (error as Error).name);
}

for (const make of [() => Decoder("bogus"), () => new Decoder("bogus"), () => new Sub("bogus" as BufferEncoding, "x")]) {
  try {
    make();
    console.log("bogus returned");
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log("bogus throws", failure.name, failure.code, failure.message);
  }
}
