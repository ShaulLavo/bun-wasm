import { KeyObject, createSecretKey, createHmac } from "node:crypto";
const input = Buffer.from("secret");
const key = createSecretKey(input);
input.fill(0);
console.log("key", key instanceof KeyObject, key.type, key.symmetricKeySize);
const exported = key.export();
console.log("export", exported.toString(), JSON.stringify(key.export({ format: "jwk" })));
exported.fill(0);
console.log("copy", key.export().toString());
console.log("equals", key.equals(createSecretKey("secret")), key.equals(createSecretKey("other")));
console.log("hmac", createHmac("sha256", key).update("hello").digest("hex"));
try { createSecretKey(42); } catch (error) { console.log("invalid", error.code); }
try { new KeyObject(); } catch (error) { console.log("constructor", error.name); }
