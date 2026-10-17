import * as z from 'node:zlib';
import {writeFileSync} from 'node:fs';
const input=Buffer.from('hello hello hello');
const dictionary=Buffer.from('dictionary words dictionary words');
const dictInput=Buffer.from('dictionary words dictionary words payload');
const specs=[['gzip','Gzip','gunzip'],['deflate','Deflate','inflate'],['deflate-raw','DeflateRaw','inflateRaw'],['brotli','BrotliCompress','brotliDecompress'],['zstd','ZstdCompress','zstdDecompress']];
const cases=[];
for(const [format,name,decode] of specs){
 const fn=name[0].toLowerCase()+name.slice(1);
 for(const dict of [false,true]){
  if(dict&&format==='gzip')continue;
  const data=dict?dictInput:input;
  const options=dict?{dictionary}:{};
  const hex=z[fn+'Sync'](data,options).toString('hex');
  cases.push({format,name,decode,input:data.toString('hex'),dictionary:dict?dictionary.toString('hex'):null,kind:'sync',hex});
 }
 for(const mode of ['none','sync','full']){
  if(mode==='full'&&(format==='brotli'||format==='zstd'))continue;
  const stream=z['create'+name]({chunkSize:64});const output=[];
  stream.on('data',c=>output.push(c));
  const done=new Promise((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject)});
  stream.write(input.subarray(0,7));
  if(mode!=='none')await new Promise((resolve,reject)=>stream.flush(format==='brotli'||format==='zstd'?1:mode==='full'?3:2,e=>e?reject(e):resolve()));
  stream.end(input.subarray(7));await done;
  cases.push({format,name,decode,input:input.toString('hex'),dictionary:null,kind:mode,hex:Buffer.concat(output).toString('hex')});
 }
}
for(const [format,name,decode] of specs){
 if(format==='gzip')continue;
 const stream=z['create'+name]({dictionary,chunkSize:64}),output=[];
 const done=new Promise((resolve,reject)=>{stream.on('data',c=>output.push(c));stream.on('end',resolve);stream.on('error',reject)});
 stream.write(dictInput.subarray(0,7));stream.end(dictInput.subarray(7));await done;
 cases.push({format,name,decode,input:dictInput.toString('hex'),dictionary:dictionary.toString('hex'),kind:'none',hex:Buffer.concat(output).toString('hex')});
}
const corrupt=[];
for(const [format,name,decode] of specs){
 const fn=name[0].toLowerCase()+name.slice(1);
 for(const data of [Buffer.from([255,255,255,255,255]),z[fn+'Sync'](input).subarray(0,4)]){
  try{z[decode+'Sync'](data)}catch(e){corrupt.push({format,name:decode,input:data.toString('hex'),code:e.code,errno:e.errno})}
 }
}
const bomb=z.gzipSync(Buffer.alloc(4*1024*1024));
const header=Buffer.alloc(512);header.write('large');header.write('0000644',100);header.write('0000000',108);header.write('0000000',116);header.write((65*1024*1024).toString(8).padStart(11,'0'),124);header.fill(32,148,156);header[156]=48;header.write('ustar',257);header.write('00',263);const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
const archiveBomb=z.gzipSync(Buffer.concat([header,Buffer.alloc(65*1024*1024),Buffer.alloc(1024)]));
const result={node:process.version,cases,corrupt,bomb:bomb.toString('hex'),archiveBomb:archiveBomb.toString('hex')};
if(process.argv[2]){
 writeFileSync(process.argv[2],JSON.stringify(result));
 const names=cases.map(c=>c.format+' '+c.kind+(c.dictionary?' dictionary':'')).concat(
  ['Bun Zstd dictionary'],corrupt.map(c=>c.format+' corrupt '+c.input),
  ['native limit before expansion','Web bounded pieces','Web compression levels','Web queuing strategy','dictionary snapshot','dictionary validation','cancel parked Web expansion','Archive gzip expansion ceiling']);
 writeFileSync(process.argv[2].replace('oracle.json','expected.txt'),names.map(n=>'PASS '+n).join('\n')+'\n');
}else console.log(JSON.stringify(result));
