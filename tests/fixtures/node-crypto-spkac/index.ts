import crypto from "node:crypto";

// crypto.Certificate (Netscape SPKAC): verification, the public key and the challenge,
// argument checks, and the empty results Bun gives for input that does not decode.
// The SPKACs come from `openssl spkac` with a synthetic RSA key; the second is signed
// with MD5, which BoringSSL does not verify.
const sha256 =
  "MIIBTTCBtzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAyp5F2hG0aC9aYsH4phY73Pu/uXiU8Uw8Sw8OR/8B9c88T1Yr4shwjMAI34M5ToPoMiJb7WUzYmdAepSsLuEdiI+E4Y7PYn/9I+p1j3dCwbSMkseuvHbHBdSpp6D+7/QURBR9n2tHLA+M6HSSA9jRqdy7QyUcrjTtmvWYdr4WVU8CAwEAARYTdGhpcyBpcyBhIGNoYWxsZW5nZTANBgkqhkiG9w0BAQsFAAOBgQCY9SOFe6fgJ/vGaSzcspw55nuwwKtAnrevqkxw5MBFCmDICIX+L3KgcROjq7ElmwjBkZ238fi+o6klhzwMLAa5Su3kVhxuy0nWPCCobhI68lbXiKz3IDHYl0Sb6Brg/2h4bbTNNqHFlrIVEwZYih4ZunqD2zmGC/26vbhc1SCcgA==";
const md5 =
  "MIIBRzCBsTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAyp5F2hG0aC9aYsH4phY73Pu/uXiU8Uw8Sw8OR/8B9c88T1Yr4shwjMAI34M5ToPoMiJb7WUzYmdAepSsLuEdiI+E4Y7PYn/9I+p1j3dCwbSMkseuvHbHBdSpp6D+7/QURBR9n2tHLA+M6HSSA9jRqdy7QyUcrjTtmvWYdr4WVU8CAwEAARYNbWQ1IGNoYWxsZW5nZTANBgkqhkiG9w0BAQQFAAOBgQBB9L23KB1yLyH59kUbemvKFcUhx9b5bU4UiszmNknyHHmnSBq2GVpvUrufobyTN2GbLlZApWtUaDc4shomeUz4QbcSsdK4/4LMh2+RRKBODJX1rulONzuG/Rf3hd7c9upNAzuAii9gWqw5cuZYM+tIeiW4oiL9owmpb8imLj6Iaw==";
const show = (label: string, run: () => unknown) => {
  try {
    const value = run();
    console.log(label, Buffer.isBuffer(value) ? `Buffer ${JSON.stringify(value.toString())}` : JSON.stringify(value));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message.replace(/ Received .*/s, " Received ..."));
  }
};
const { Certificate } = crypto;
show("verify sha256", () => Certificate.verifySpkac(Buffer.from(sha256)));
show("verify sha256 string", () => new Certificate().verifySpkac(sha256 as never));
show("verify trailing newline", () => Certificate.verifySpkac(Buffer.from(`${sha256}\n`)));
show("verify ArrayBuffer", () => Certificate.verifySpkac(new TextEncoder().encode(sha256).buffer));
show("verify hex", () => Certificate.verifySpkac(Buffer.from(sha256).toString("hex") as never, "hex" as never));
show("verify md5", () => Certificate.verifySpkac(Buffer.from(md5)));
show("verify tampered", () => Certificate.verifySpkac(Buffer.from(sha256.slice(0, 40) + (sha256[40] === "A" ? "B" : "A") + sha256.slice(41))));
show("verify invalid", () => Certificate.verifySpkac(Buffer.from("not a spkac")));
show("challenge", () => Certificate.exportChallenge(sha256));
show("challenge md5", () => Certificate.exportChallenge(md5));
show("challenge invalid", () => Certificate.exportChallenge("not a spkac"));
show("public key", () => Certificate.exportPublicKey(sha256));
show("public key invalid", () => Certificate.exportPublicKey("not a spkac"));
show("verify 42", () => Certificate.verifySpkac(42 as never));
const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
for (const key of [pair.publicKey, pair.privateKey, crypto.createSecretKey(Buffer.from("secret"))]) {
  for (const method of ["verifySpkac", "exportPublicKey", "exportChallenge"] as const) {
    show(`${method} ${key.type} KeyObject`, () => Certificate[method](key as never));
  }
}
show("Certificate()", () => (Certificate as unknown as () => object)() instanceof Certificate);
