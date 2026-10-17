import * as z from 'node:zlib';
import oracle from './oracle.json';
const {Buffer}=await import('node:buffer');
let failures=0;
async function check(name,fn){try{await fn();console.log('PASS '+name)}catch(e){failures++;console.log('FAIL '+name+' '+e)}}
function equal(actual,expected){if(actual!==expected)throw new Error(String(actual)+' != '+String(expected))}
for(const c of oracle.cases){await check(c.format+' '+c.kind+(c.dictionary?' dictionary':''),async()=>{
 const input=Buffer.from(c.input,'hex'), dictionary=c.dictionary?Buffer.from(c.dictionary,'hex'):undefined;
 const options={dictionary,chunkSize:64};
 const fn=c.name[0].toLowerCase()+c.name.slice(1);
 let output;
 if(c.kind==='sync')output=z[fn+'Sync'](input,options);
 else{
  const stream=z['create'+c.name](options), chunks=[];
  const finished=new Promise((resolve,reject)=>{stream.on('data',x=>chunks.push(x));stream.on('end',resolve);stream.on('error',reject)});
  stream.write(input.subarray(0,7));
  if(c.kind!=='none')await new Promise((resolve,reject)=>stream.flush(c.format==='brotli'||c.format==='zstd'?1:c.kind==='full'?3:2,e=>e?reject(e):resolve()));
  stream.end(input.subarray(7));await finished;output=Buffer.concat(chunks);
 }
 equal(output.toString('hex'),c.hex);
 equal(z[c.decode+'Sync'](Buffer.from(c.hex,'hex'),options).toString('hex'),c.input);
})}
await check('Bun Zstd dictionary',()=>{const c=oracle.cases.find(c=>c.format==='zstd'&&c.dictionary&&c.kind==='sync');const dictionary=Buffer.from(c.dictionary,'hex');const encoded=Bun.zstdCompressSync(Buffer.from(c.input,'hex'),{dictionary});equal(Buffer.from(encoded).toString('hex'),c.hex);equal(Buffer.from(Bun.zstdDecompressSync(encoded,{dictionary})).toString('hex'),c.input)});
for(const c of oracle.corrupt)await check(c.format+' corrupt '+c.input,async()=>{
 let error;try{z[c.name+'Sync'](Buffer.from(c.input,'hex'))}catch(e){error=e}
 equal(error?.code,c.code);equal(error?.errno,c.errno);
 const stream=z['create'+c.name[0].toUpperCase()+c.name.slice(1)]();
 const failure=new Promise(resolve=>stream.on('error',resolve));stream.resume();stream.end(Buffer.from(c.input,'hex'));
 const err=await failure;equal(err.code,c.code);equal(err.errno,c.errno);
});
await check('native limit before expansion',()=>{
 const decoder=new z.Gunzip({maxOutputLength:1024});
 try{decoder._processChunk(Buffer.from(oracle.bomb,'hex'),z.constants.Z_NO_FLUSH);throw new Error('missing limit')}catch(e){equal(e.code,'ERR_BUFFER_TOO_LARGE')}finally{decoder.close()}
});
await check('Archive gzip expansion ceiling',async()=>{
 for(const operation of ['files','extract']){let error;try{const archive=new Bun.Archive(Buffer.from(oracle.archiveBomb,'hex'));await archive[operation]('large-output')}catch(e){error=e}equal(error?.code,'ERR_BUFFER_TOO_LARGE')}
});
await check('Web bounded pieces',async()=>{
 const cs=new DecompressionStream('gzip',{highWaterMark:1024});
 const written=(async()=>{const w=cs.writable.getWriter();await w.write(Buffer.from(oracle.bomb,'hex'));await w.close()})();written.catch(()=>{});
 let count=0;for await(const piece of cs.readable){if(piece.length>1024)throw new Error('piece '+piece.length);count+=piece.length}
 await written;equal(count,4*1024*1024);
});
await check('Web compression levels',async()=>{
 for(const [format,lo,hi] of [['gzip',0,9],['brotli',1,11],['zstd',1,19]]){
  const sizes=[];
  for(const level of [lo,hi]){const data=new TextEncoder().encode('some repeating data '.repeat(4096));const cs=new CompressionStream(format,{level,highWaterMark:1024});const written=(async()=>{const w=cs.writable.getWriter();await w.write(data);await w.close()})();written.catch(()=>{});let size=0;for await(const piece of cs.readable){if(piece.length>1024)throw new Error('piece '+piece.length);size+=piece.length}await written;sizes.push(size)}
  if(sizes[0]===sizes[1])throw new Error(format+' ignored level');
 }
 for(const [format,level] of [['gzip',99],['brotli',12],['zstd',0]]){let error;try{new CompressionStream(format,{level})}catch(e){error=e}if(!(error instanceof RangeError))throw new Error(format+' accepted invalid level')}
});
await check('Web queuing strategy',async()=>{
 for(const size of [16384,1048576,Infinity]){
  const ds=new DecompressionStream('gzip',{highWaterMark:size});
  const w=ds.writable.getWriter();const writing=w.write(Buffer.from(oracle.bomb,'hex'));
  let largest=0,total=0;const read=(async()=>{for await(const c of ds.readable){largest=Math.max(largest,c.length);total+=c.length}})();
  await writing;await w.close();await read;equal(total,4*1024*1024);equal(largest,Math.min(size,4*1024*1024));
 }
 for(const options of [{highWaterMark:-1},{highWaterMark:NaN},4096]){let err;try{new CompressionStream('gzip',options)}catch(e){err=e}if(!err)throw new Error('invalid strategy accepted')}
 new DecompressionStream('gzip',{level:99});
});
await check('dictionary snapshot',async()=>{
 const c=oracle.cases.find(c=>c.format==='deflate'&&c.dictionary);const dictionary=Buffer.from(c.dictionary,'hex');const stream=z.createDeflate({dictionary});dictionary.fill(0);const chunks=[];const done=new Promise((resolve,reject)=>{stream.on('data',c=>chunks.push(c));stream.on('end',resolve);stream.on('error',reject)});stream.end(Buffer.from(c.input,'hex'));await done;equal(Buffer.concat(chunks).toString('hex'),c.hex);
});
await check('dictionary validation',()=>{for(const name of ['deflate','brotliCompress','zstdCompress']){let e;try{z[name+'Sync']('hello',{dictionary:'invalid'})}catch(error){e=error}equal(e?.code,'ERR_INVALID_ARG_TYPE')}});
await check('cancel parked Web expansion',async()=>{const ds=new DecompressionStream('gzip',{highWaterMark:1024});const writer=ds.writable.getWriter();const reader=ds.readable.getReader();const write=writer.write(Buffer.from(oracle.bomb,'hex'));await reader.read();const closed=writer.closed.catch(()=>{});await reader.cancel(new Error('cancelled'));await write;await closed});

if(failures)throw new Error(failures+' compression regressions');
