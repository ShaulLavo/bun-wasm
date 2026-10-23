// Original contract probes. Shell command expectations follow bash-web 0.0.91.
export const binaryBytes = 1024 * 1024 + 257;
export const previewPort = 31976;
export const guests: Record<string, string> = {
  "files.ts": `import fs from 'node:fs';
console.log('CONTEXT:'+process.cwd()+':'+process.env.TEST_VALUE);
fs.writeFileSync('output',fs.readFileSync('input')); fs.unlinkSync('deleted');
fs.mkdirSync('nested'); fs.writeFileSync('nested/new','created'); process.exit(9);`,
  "endless.ts": `setInterval(()=>process.stdout.write('first\\n'),1);`,
  "stdin-reader.ts": `console.log('NESTED_STDIN:'+await Bun.stdin.text());`,
  "stdin-parent.ts": `const child=Bun.spawn(['bun','run','/fixtures/stdin-reader.ts'],{stdin:'inherit',stdout:'inherit',stderr:'inherit'}); process.exit(await child.exited);`,
  "ticker.ts": `for(let i=0;i<10;i++){console.log('TICK:'+i);await Bun.sleep(150);}console.log('PRODUCER_EXIT');`,
  "binary-writer.ts": `import fs from 'node:fs';
const bytes=new Uint8Array(${binaryBytes});for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+17)%256;
let offset=0;while(offset<bytes.length)offset+=fs.writeSync(1,bytes,offset,Math.min(16384,bytes.length-offset));`,
  "binary-reader.ts": `import fs from 'node:fs';
await Bun.sleep(200); const chunk=new Uint8Array(8192);let offset=0;for(;;){const count=fs.readSync(0,chunk,0,chunk.length,null);if(!count)break;for(let i=0;i<count;i++){if(chunk[i]!==((offset+i)*31+17)%256)throw Error('byte mismatch at '+(offset+i));}offset+=count;}
if(offset!==${binaryBytes})throw Error('wrong count '+offset);console.log('BINARY_EXACT:'+offset);`,
  "descendant.ts": `console.log('DESCENDANT_READY');for(;;)await Bun.sleep(100);`,
  "parent.ts": `const child=Bun.spawn(['bun','run','/fixtures/descendant.ts'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});console.log('PARENT_READY');await child.exited;`,
  "background.ts": `console.log('INDEPENDENT_READY');let n=0;for(;;){await Bun.write('/background-alive',String(++n));await Bun.sleep(50);}`,
  "survivor.ts": `console.log('BORROWER_READY');let n=0;for(;;){await Bun.write('/borrower-alive',String(++n));await Bun.sleep(50);}`,
  "preview.ts": `Bun.serve({port:${previewPort},fetch(){return new Response('REAL_SHELL_PREVIEW',{headers:{'content-type':'text/plain'}});}});console.log('PREVIEW_READY');`,
};

export const commands = {
  lookup: `bun -e 'console.log("EXTERNAL_OK")'`,
  files: `mkdir demo; cd demo; export TEST_VALUE=from-shell; printf source > input; printf remove > deleted; bun run /fixtures/files.ts > captured; echo FILE_STATUS:$?; cat captured; cat output; echo; cat nested/new; echo; bun -e 'if(!require("node:fs").existsSync("deleted"))console.log("DELETE_OK")'; printf appended >> output; bun -e 'console.log("MERGED:"+require("node:fs").readFileSync("output","utf8"))'`,
  epipe: `set -o pipefail; bun run /fixtures/endless.ts | { IFS= read -r line; echo "$line"; }; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
  stdin: `printf payload | bun run /fixtures/stdin-parent.ts`,
  ticker: `bun run /fixtures/ticker.ts | while IFS= read -r line; do echo "FILTER:$line"; done`,
  binary: `set -o pipefail; bun run /fixtures/binary-writer.ts | bun run /fixtures/binary-reader.ts; printf 'BINARY_STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
};
