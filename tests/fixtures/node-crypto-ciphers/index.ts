import crypto from "node:crypto";

// node:crypto createCipheriv and createDecipheriv: NIST SP 800-38A and GCM spec vectors,
// streaming, padding, authenticated encryption, and Node's argument checks with native
// Bun's messages.
const hex = (value: string) => Buffer.from(value.replace(/\s+/g, ""), "hex");
const describe = (value: unknown) =>
  value instanceof Uint8Array ? `${value.constructor.name} ${Buffer.from(value).toString("hex")}` : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
const show = (label: string, make: () => unknown) => {
  try {
    console.log(label, describe(make()));
  } catch (error) {
    const failure = error as Error & { code?: string; reason?: string; library?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message, failure.library ?? "", failure.reason ?? "");
  }
};
const run = (name: string, key: Buffer, iv: Buffer | null, input: Buffer, decrypt = false, padding = true) => {
  const cipher = decrypt ? crypto.createDecipheriv(name, key, iv) : crypto.createCipheriv(name, key, iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(input), cipher.final()]);
};

const sp80038a = hex(`6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51
  30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710`);
const key128 = hex("2b7e151628aed2a6abf7158809cf4f3c");
const key256 = hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4");
const iv = hex("000102030405060708090a0b0c0d0e0f");
const counter = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
const vectors: [string, Buffer, Buffer | null, string][] = [
  ["aes-128-ecb", key128, null, "3ad77bb40d7a3660a89ecaf32466ef97f5d3d58503b9699de785895a96fdbaaf43b1cd7f598ece23881b00e3ed0306887b0c785e27e8ad3f8223207104725dd4"],
  ["aes-128-cbc", key128, iv, "7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7"],
  ["aes-256-cbc", key256, iv, "f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b"],
  ["aes-128-ctr", key128, counter, "874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff5ae4df3edbd5d35e5b4f09020db03eab1e031dda2fbe03d1792170a0f3009cee"],
  ["aes-256-ctr", key256, counter, "601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c52b0930daa23de94ce87017ba2d84988ddfc9c58db67aada613c2dd08457941a6"],
  ["aes-128-ofb", key128, iv, "3b3fd92eb72dad20333449f8e83cfb4a7789508d16918f03f53c52dac54ed8259740051e9c5fecf64344f7a82260edcc304c6528f659c77866a510d9c1d6ae5e"],
  ["aes-128-cfb", key128, iv, "3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b26751f67a3cbb140b1808cf187a4f4dfc04b05357c5d1c0eeac4c66f9ff7f2e6"],
];
for (const [name, key, nonce, expected] of vectors) {
  const ciphertext = run(name, key, nonce, sp80038a, false, false);
  console.log(name, "sp800-38a", ciphertext.toString("hex") === expected, run(name, key, nonce, ciphertext, true, false).equals(sp80038a));
}

// Padding, streaming chunk sizes and string encodings.
const message = "Out of the mountain of despair, a stone of hope.";
const cbcKey = hex("3fad401bb178066f201b55368712530229d6329a5e2c05f48ff36ca65792d21d");
const cbcIv = hex("22371787d3e04a6589d8a1de50c81208");
const padded = run("aes-256-cbc", cbcKey, cbcIv, Buffer.from(message));
console.log("cbc padded", padded.toString("hex"));
console.log("cbc unpadded", run("aes-256-cbc", cbcKey, cbcIv, padded, true).toString());
{
  const cipher = crypto.createCipheriv("aes-256-cbc", cbcKey, cbcIv);
  const parts = [cipher.update(message.slice(0, 5)), cipher.update(message.slice(5, 21), "utf8"), cipher.update(Buffer.from(message.slice(21))), cipher.final()];
  console.log("cbc chunks", parts.map(part => part.length).join(","), Buffer.concat(parts).equals(padded));
}
{
  const cipher = crypto.createCipheriv("aes-256-cbc", cbcKey, cbcIv);
  const text = cipher.update(message, "utf8", "base64") + cipher.final("base64");
  console.log("cbc base64", text);
  const decipher = crypto.createDecipheriv("aes-256-cbc", cbcKey, cbcIv);
  console.log("cbc base64 back", decipher.update(text, "base64", "utf8") + decipher.final("utf8"));
}
{
  const cipher = crypto.createCipheriv("aes-128-ctr", key128, counter);
  console.log("ctr hex parts", cipher.update("abc", "latin1", "hex"), cipher.update(new Uint8Array([1, 2, 3, 4, 5])).toString("hex"), cipher.final("hex"));
}
show("cbc no padding partial block", () => run("aes-128-cbc", key128, iv, Buffer.from("short"), false, false));
show("cbc wrong key", () => run("aes-256-cbc", Buffer.alloc(32, 1), cbcIv, padded, true));
show("cbc truncated", () => run("aes-256-cbc", cbcKey, cbcIv, padded.subarray(0, 40), true));
show("cbc empty", () => run("aes-128-cbc", key128, iv, Buffer.alloc(0)));
show("ecb dataview", () => run("aes-128-ecb", key128, null, Buffer.from(new DataView(new ArrayBuffer(16)).buffer)));

// GCM (McGrew and Viega test cases 2, 4 and 6).
{
  const cipher = crypto.createCipheriv("aes-128-gcm", Buffer.alloc(16), Buffer.alloc(12));
  const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()]);
  console.log("gcm tc2", ciphertext.toString("hex") === "0388dace60b6a392f328c2b971b2fe78", cipher.getAuthTag().toString("hex") === "ab6e47d42cec13bdf53a67b21257bddf");
}
const gcmKey = hex("feffe9928665731c6d6a8f9467308308");
const gcmPlain = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
const gcmAad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
{
  const cipher = crypto.createCipheriv("aes-128-gcm", gcmKey, hex("cafebabefacedbaddecaf888"));
  cipher.setAAD(gcmAad);
  const ciphertext = Buffer.concat([cipher.update(gcmPlain), cipher.final()]);
  const tag = cipher.getAuthTag();
  console.log("gcm tc4", ciphertext.toString("hex") === "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091", tag.toString("hex") === "5bc94fbc3221a5db94fae95ae7121a47");
  const decipher = crypto.createDecipheriv("aes-128-gcm", gcmKey, hex("cafebabefacedbaddecaf888"));
  decipher.setAAD(gcmAad);
  decipher.setAuthTag(tag);
  console.log("gcm tc4 open", Buffer.concat([decipher.update(ciphertext), decipher.final()]).equals(gcmPlain));
  const forged = crypto.createDecipheriv("aes-128-gcm", gcmKey, hex("cafebabefacedbaddecaf888"));
  forged.setAAD(gcmAad);
  forged.setAuthTag(Buffer.from(tag).fill(0, 0, 1));
  show("gcm tc4 forged update", () => forged.update(ciphertext).length);
  show("gcm tc4 forged final", () => forged.final());
  const noTag = crypto.createDecipheriv("aes-128-gcm", gcmKey, hex("cafebabefacedbaddecaf888"));
  noTag.update(ciphertext);
  show("gcm without tag final", () => noTag.final());
}
{
  const nonce = hex(`9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b`);
  const cipher = crypto.createCipheriv("aes-128-gcm", gcmKey, nonce);
  cipher.setAAD(gcmAad);
  const ciphertext = Buffer.concat([cipher.update(gcmPlain), cipher.final()]);
  console.log("gcm tc6", ciphertext.toString("hex") === "8ce24998625615b603a033aca13fb894be9112a5c3a211a8ba262a3cca7e2ca701e4a9a4fba43c90ccdcb281d48c7c6fd62875d2aca417034c34aee5", cipher.getAuthTag().toString("hex") === "619cc5aefffe0bfa462af43c1699d050");
}
for (const authTagLength of [4, 8, 12, 13, 16, 3, 17]) {
  show(`gcm authTagLength ${authTagLength}`, () => {
    const cipher = crypto.createCipheriv("aes-256-gcm", key256, Buffer.alloc(12), { authTagLength });
    cipher.update("x");
    cipher.final();
    return cipher.getAuthTag();
  });
}
for (const ivLength of [1, 8, 16, 64, 128, 129, 0]) {
  show(`gcm iv ${ivLength}`, () => {
    const cipher = crypto.createCipheriv("aes-192-gcm", Buffer.alloc(24, 7), Buffer.alloc(ivLength, 9));
    return Buffer.concat([cipher.update("hello"), cipher.final(), cipher.getAuthTag()]);
  });
}
{
  const cipher = crypto.createCipheriv("aes-256-gcm", key256, Buffer.alloc(12));
  show("gcm getAuthTag before final", () => cipher.getAuthTag());
  show("gcm setAAD string", () => cipher.setAAD("0123456789abcdef", { encoding: "hex" }) === cipher);
  show("gcm setAAD plaintextLength", () => cipher.setAAD(Buffer.alloc(1), { plaintextLength: -1 }));
  show("gcm setAAD bad encoding option", () => cipher.setAAD("ab", { encoding: 1 as never }));
  cipher.update("data");
  cipher.final();
  show("gcm setAAD after final", () => cipher.setAAD(Buffer.alloc(1)));
  show("gcm update after final", () => cipher.update("more"));
  show("gcm final twice", () => cipher.final());
  show("gcm setAutoPadding after final", () => cipher.setAutoPadding(false));
  console.log("gcm cipher has setAuthTag", "setAuthTag" in cipher);
}
{
  const decipher = crypto.createDecipheriv("aes-256-gcm", key256, Buffer.alloc(12));
  show("gcm setAuthTag short", () => decipher.setAuthTag(Buffer.alloc(8)));
  show("gcm setAuthTag hex", () => decipher.setAuthTag("00".repeat(16), "hex") === decipher);
  show("gcm setAuthTag twice", () => decipher.setAuthTag(Buffer.alloc(16)));
  console.log("gcm decipher has getAuthTag", "getAuthTag" in decipher);
}
show("gcm setAAD after update", () => {
  const cipher = crypto.createCipheriv("aes-128-gcm", key128, Buffer.alloc(12));
  cipher.update("abc");
  return cipher.setAAD(Buffer.alloc(2)) === cipher;
});

// Other ciphers BoringSSL provides.
for (const [name, keyLength, ivLength] of [["des-ede3-cbc", 24, 8], ["des-ede3", 24, 0], ["des-ede-cbc", 16, 8], ["des-cbc", 8, 8], ["des-ecb", 8, 0], ["bf-cbc", 16, 8], ["bf-ecb", 16, 0], ["bf-cfb", 16, 8], ["rc4", 16, 0], ["rc2-cbc", 16, 8], ["aes-192-ecb", 24, 0], ["aes-256-cfb", 32, 16], ["aes256", 32, 16], ["AES-128-CBC", 16, 16], ["3des", 24, 8]] as const) {
  show(`cipher ${name}`, () => {
    const ciphertext = run(name, Buffer.alloc(keyLength, 3), ivLength ? Buffer.alloc(ivLength, 5) : null, Buffer.from(message));
    return `${ciphertext.toString("hex")} ${run(name, Buffer.alloc(keyLength, 3), ivLength ? Buffer.alloc(ivLength, 5) : null, ciphertext, true).toString() === message}`;
  });
}
show("bf-cbc variable key", () => run("bf-cbc", Buffer.alloc(5, 1), Buffer.alloc(8), Buffer.from("abc")));
show("rc4 variable key", () => run("rc4", Buffer.alloc(40, 1), null, Buffer.from("abc")));

// Argument checks.
show("unknown cipher", () => crypto.createCipheriv("aes-128-xyz", key128, iv));
show("cipher not string", () => crypto.createCipheriv(1 as never, key128, iv));
show("key wrong length", () => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(15), iv));
show("key wrong type", () => crypto.createCipheriv("aes-128-cbc", 5 as never, iv));
show("key string", () => run("aes-128-ecb", "0123456789abcdef" as never, null, Buffer.from("x")));
show("key hex encoding option", () => {
  const cipher = crypto.createCipheriv("aes-128-ecb", "00112233445566778899aabbccddeeff", null, { encoding: "hex" } as never);
  return Buffer.concat([cipher.update("x"), cipher.final()]);
});
show("key KeyObject", () => run("aes-256-ecb", crypto.createSecretKey(key256) as never, null, Buffer.from("Hello world")));
show("key private KeyObject", () => crypto.createCipheriv("aes-128-cbc", crypto.generateKeyPairSync("ed25519").privateKey as never, iv));
show("iv wrong length", () => crypto.createCipheriv("aes-128-cbc", key128, Buffer.alloc(8)));
show("iv missing", () => crypto.createCipheriv("aes-128-cbc", key128, undefined as never));
show("iv null for cbc", () => crypto.createCipheriv("aes-128-cbc", key128, null));
show("iv wrong type", () => crypto.createCipheriv("aes-128-cbc", key128, 5 as never));
show("iv string", () => crypto.createCipheriv("aes-128-cbc", key128, "0123456789abcdef").update("x").length);
show("iv for ecb", () => crypto.createCipheriv("aes-128-ecb", key128, Buffer.alloc(16)));
show("empty iv for ecb", () => crypto.createCipheriv("aes-128-ecb", key128, Buffer.alloc(0)).update("x").length);
show("authTagLength negative", () => crypto.createCipheriv("aes-128-gcm", key128, Buffer.alloc(12), { authTagLength: -1 }));
show("authTagLength fraction", () => crypto.createCipheriv("aes-128-gcm", key128, Buffer.alloc(12), { authTagLength: 4.5 }));
show("authTagLength on cbc", () => crypto.createCipheriv("aes-128-cbc", key128, iv, { authTagLength: 99 } as never).update("x").length);
show("options encoding not string", () => crypto.createCipheriv("aes-128-cbc", key128, iv, { encoding: 5 } as never));
show("update array", () => crypto.createCipheriv("aes-128-cbc", key128, iv).update(["c", "d"] as never));
show("update number", () => crypto.createCipheriv("aes-128-cbc", key128, iv).update(5 as never));
show("setAAD on cbc", () => crypto.createCipheriv("aes-128-cbc", key128, iv).setAAD(Buffer.alloc(4)));
show("setAAD on ctr decipher", () => crypto.createDecipheriv("aes-128-ctr", key128, iv).setAAD(Buffer.alloc(4)));
show("getAuthTag on cbc", () => {
  const cipher = crypto.createCipheriv("aes-128-cbc", key128, iv);
  cipher.final();
  return cipher.getAuthTag();
});
show("setAutoPadding chain", () => {
  const cipher = crypto.createCipheriv("aes-128-cbc", key128, iv);
  return cipher.setAutoPadding() === cipher;
});
show("update encoding change", () => {
  const cipher = crypto.createCipheriv("aes-128-ctr", key128, iv);
  cipher.update("a", "utf8", "hex");
  return cipher.update("b", "utf8", "base64");
});
show("update unknown output encoding", () => crypto.createCipheriv("aes-128-ctr", key128, iv).update("a", "utf8", "nope" as never));

// Shape of the classes.
{
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(16));
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(16));
  console.log("names", cipher.update.name, cipher.final.name, cipher.setAutoPadding.name, (cipher as unknown as crypto.CipherGCM).getAuthTag.name, (cipher as unknown as crypto.CipherGCM).setAAD.name, cipher._transform.name, (decipher as unknown as crypto.DecipherGCM).setAuthTag.name);
  console.log("instances", cipher instanceof crypto.Cipheriv, decipher instanceof crypto.Decipheriv, typeof cipher.pipe, crypto.createCipheriv.name, crypto.createDecipheriv.name, crypto.Cipheriv.length);
  console.log("call without new", (crypto.Cipheriv as unknown as Function)("aes-128-ecb", key128, null) instanceof crypto.Cipheriv);
}

// getCiphers and getCipherInfo.
console.log("getCiphers", JSON.stringify(crypto.getCiphers()));
for (const name of ["aes-128-cbc", "aes-256-gcm", "AES-192-CTR", "aes-128-ecb", "rc4", "bf-cbc", "des-ede3", "aes-128-cfb", "aes-128-ofb", "aes256", "chacha20-poly1305", "nope"]) {
  show(`getCipherInfo ${name}`, () => crypto.getCipherInfo(name));
}
show("getCipherInfo nid", () => crypto.getCipherInfo(crypto.getCipherInfo("aes-128-cbc")!.nid));
show("getCipherInfo double nid", () => crypto.getCipherInfo(new Float64Array([419])[0]));
show("getCipherInfo keyLength", () => crypto.getCipherInfo("aes-128-cbc", { keyLength: 16 }));
show("getCipherInfo bad keyLength", () => crypto.getCipherInfo("aes-128-cbc", { keyLength: 12 }));
show("getCipherInfo rc4 keyLength", () => crypto.getCipherInfo("rc4", { keyLength: 9 }));
show("getCipherInfo gcm ivLength", () => crypto.getCipherInfo("aes-128-gcm", { ivLength: 7 }));
show("getCipherInfo cbc ivLength", () => crypto.getCipherInfo("aes-128-cbc", { ivLength: 7 }));
show("getCipherInfo bad arg", () => crypto.getCipherInfo({} as never));
show("getCipherInfo bad options", () => crypto.getCipherInfo("aes-128-cbc", 5 as never));
show("getCipherInfo string keyLength", () => crypto.getCipherInfo("aes-128-cbc", { keyLength: "16" } as never));

// As a stream.
{
  const cipher = crypto.createCipheriv("aes-256-cbc", cbcKey, cbcIv);
  const events: string[] = [];
  for (const event of ["prefinish", "finish", "end"]) cipher.on(event, () => events.push(event));
  const chunks: Buffer[] = [];
  cipher.on("data", chunk => chunks.push(chunk));
  cipher.write(message.slice(0, 10));
  cipher.end(message.slice(10));
  await new Promise(resolve => cipher.on("end", resolve));
  console.log("stream", Buffer.concat(chunks).equals(padded), events.join(","));
}
{
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.alloc(32), cbcIv);
  const failure = await new Promise(resolve => {
    decipher.on("error", resolve);
    decipher.on("data", () => {});
    decipher.end(padded);
  });
  console.log("stream error", failure instanceof Error);
}
