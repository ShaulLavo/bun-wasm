import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const s = webcrypto.subtle;
const b64 = b => Buffer.from(b).toString('base64url');
const data = new TextEncoder().encode('bun-wasm interoperable crypto vectors');
const vectors = {data:b64(data),sign:[],encrypt:[],derive:[],agree:[]};
for (const name of ['HMAC','RSASSA-PKCS1-v1_5','RSA-PSS','ECDSA','Ed25519']) {
  const curves = name==='ECDSA'?['P-256','P-384']:[undefined];
  for (const namedCurve of curves) {
    const a = {name,...(namedCurve?{namedCurve}:{}),...(['HMAC','RSASSA-PKCS1-v1_5','RSA-PSS'].includes(name)?{hash:'SHA-256'}:{}),...(name.startsWith('RSA')?{modulusLength:1024,publicExponent:new Uint8Array([1,0,1])}:{})};
    const pair = await s.generateKey(a,true,['sign','verify']);
    const priv = pair.privateKey || pair, pub = pair.publicKey || pair;
    const op = {...a,...(name==='ECDSA'?{hash:'SHA-384'}:{}),...(name==='RSA-PSS'?{saltLength:32}:{})};
    const entry = {algorithm:{...a,publicExponent:undefined},operation:{...op,publicExponent:undefined},private:await s.exportKey('jwk',priv),public:await s.exportKey('jwk',pub),signature:b64(await s.sign(op,priv,data))};
    if (pair.privateKey) {entry.pkcs8=b64(await s.exportKey('pkcs8',priv));entry.spki=b64(await s.exportKey('spki',pub));}
    vectors.sign.push(entry);
  }
}
for (const name of ['AES-GCM','AES-CBC','AES-CTR']) {
  for (const length of [128,192,256]) {
    const key = await s.importKey('raw',new Uint8Array(length/8).fill(0x41),{name},true,['encrypt','decrypt']);
    const tags = name==='AES-GCM'?[32,64,96,104,112,120,128]:[undefined];
    for (const tagLength of tags) {
      const iv = new Uint8Array(name==='AES-GCM' && tagLength===128?16:name==='AES-GCM'?12:16).fill(0x31);
      const op = name==='AES-CTR'?{name,counter:new Uint8Array(16).fill(255),length:3}:{name,iv,...(name==='AES-GCM'?{tagLength,additionalData:new Uint8Array([1,2,3])}:{})};
      const result = await s.encrypt(op,key,data);
      vectors.encrypt.push({algorithm:{name},operation:{...op,iv:op.iv?b64(op.iv):undefined,counter:op.counter?b64(op.counter):undefined,additionalData:op.additionalData?b64(op.additionalData):undefined},key:await s.exportKey('jwk',key),ciphertext:b64(result)});
    }
  }
}
const oaep = await s.generateKey({name:'RSA-OAEP',modulusLength:1024,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
const label = new Uint8Array([0,255,128,1]);
vectors.encrypt.push({algorithm:{name:'RSA-OAEP',hash:'SHA-256'},operation:{name:'RSA-OAEP',label:b64(label)},private:await s.exportKey('jwk',oaep.privateKey),public:await s.exportKey('jwk',oaep.publicKey),ciphertext:b64(await s.encrypt({name:'RSA-OAEP',label},oaep.publicKey,data))});
for (const name of ['HKDF','PBKDF2']) {
  for (const hash of ['SHA-1','SHA-256','SHA-384','SHA-512']) {
    const key = await s.importKey('raw',data,name,false,['deriveBits']);
    const salt = new Uint8Array([1,2,3]), info = new Uint8Array([4,5,6]);
    const op = {name,hash,salt,...(name==='HKDF'?{info}:{iterations:17})};
    vectors.derive.push({operation:{...op,salt:b64(salt),info:op.info?b64(info):undefined},bits:b64(await s.deriveBits(op,key,256))});
  }
}
for (const algorithm of [{name:'ECDH',namedCurve:'P-256'},{name:'ECDH',namedCurve:'P-384'},{name:'X25519'}]) {
  const a=await s.generateKey(algorithm,true,['deriveBits']),b=await s.generateKey(algorithm,true,['deriveBits']);
  vectors.agree.push({algorithm,private:await s.exportKey('jwk',a.privateKey),public:await s.exportKey('jwk',b.publicKey),bits:b64(await s.deriveBits({...algorithm,public:b.publicKey},a.privateKey,256))});
}
writeFileSync(new URL('../tests/fixtures/crypto-vectors/vectors.json',import.meta.url),JSON.stringify(vectors,null,2)+'\n');
console.log('wrote',vectors.sign.length+vectors.encrypt.length+vectors.derive.length+vectors.agree.length,'native Node vectors');
