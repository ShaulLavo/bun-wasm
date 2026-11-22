import crypto from "node:crypto";

// generateKeyPair's "rsa-pss" options as Bun checks them before its BoringSSL refuses the key
// type, and the error a JWK export of a P-224 key reports.
const show = (label: string, run: () => unknown) => {
  try {
    console.log(label, String(run()));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(label, "throws", failure.name, failure.code, failure.message);
  }
};
const warnings: string[] = [];
process.on("warning", warning => warnings.push(`${(warning as Error & { code?: string }).code} ${warning.message}`));

const modulusLength = 512;
const pss = (options: object) => () => crypto.generateKeyPairSync("rsa-pss", { modulusLength, ...options } as never);
show("rsa-pss", pss({}));
show("rsa-pss options", pss({ hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha1", saltLength: 16 }));
show("exponent", pss({ publicExponent: 4 }));
show("hash", pss({ hash: "sha256" }));
show("hash type", pss({ hash: 1 }));
show("hash mismatch", pss({ hash: "sha256", hashAlgorithm: "sha1" }));
show("mgf1Hash mismatch", pss({ mgf1Hash: "sha256", mgf1HashAlgorithm: "sha1" }));
show("hashAlgorithm type", pss({ hashAlgorithm: 1 }));
show("bad digest", pss({ hashAlgorithm: "nope" }));
show("bad mgf1 digest", pss({ mgf1HashAlgorithm: "nope" }));
show("salt range", pss({ saltLength: -1 }));
show("salt type", pss({ saltLength: "1" }));
show("check order", pss({ saltLength: -1, hashAlgorithm: 1 }));

crypto.generateKeyPair("rsa-pss", { modulusLength } as never, (error: (Error & { code?: string }) | null) => {
  console.log("rsa-pss callback", error?.name, error?.code);
  crypto.generateKeyPair(
    "ec",
    { namedCurve: "secp224r1", publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } } as never,
    (error: (Error & { code?: string }) | null) => {
      console.log("p224 jwk", error?.name, error?.code, error?.message);
      setImmediate(() => console.log("warnings", warnings.join(" | ")));
    },
  );
});
