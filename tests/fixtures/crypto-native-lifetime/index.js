const s = crypto.subtle;
s.importKey("raw", new TextEncoder().encode("password"), "PBKDF2", false, ["deriveBits"])
  .then(key => s.deriveBits({name:"PBKDF2", hash:"SHA-256", salt:new TextEncoder().encode("salt"), iterations:50000}, key, 128))
  .then(bits => console.log("native crypto settled", Buffer.from(bits).toString("hex")));
