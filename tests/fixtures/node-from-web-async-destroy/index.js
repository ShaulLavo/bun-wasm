import { Writable } from "node:stream";
const tick = () => new Promise(resolve => setImmediate(resolve));
const results=[];
for (const mode of ['close','write','abort']) {
 const pendingWrite=mode==='write';
 const reason=mode==='abort'?new Error('abort source'):undefined;
 let complete;let streamClosed=false;let sinkDone=false;let closeBeforeSinkDone;
 const web=new WritableStream(mode==='abort'?{
   abort(){return new Promise(resolve=>{complete=()=>{sinkDone=true;resolve();};});},
 } : pendingWrite ? {
   write(){return new Promise(resolve=>{complete=()=>{sinkDone=true;resolve();};});},
 } : {
   close(){return new Promise(resolve=>{complete=()=>{sinkDone=true;resolve();};});},
 });
 const node=Writable.fromWeb(web);node.on('error',error=>{if(error!==reason)throw error;});
 const closed=new Promise(resolve=>node.once('close',()=>{streamClosed=true;closeBeforeSinkDone=!sinkDone;resolve();}));
 if(pendingWrite){node.write('queued');await tick();}
 node.destroy(reason);await tick();const closedEarly=streamClosed;
 const lateWriteError=await new Promise(resolve=>node.write('late',resolve));
 if(lateWriteError?.code!=='ERR_STREAM_DESTROYED')throw new Error('Late write was not rejected');
 complete();await closed;await tick();
 results.push({mode,closedEarly,closeBeforeSinkDone});
}
console.log(JSON.stringify(results));
if(results.some(result=>result.closedEarly||result.closeBeforeSinkDone)) throw new Error('Node close emitted before Web sink completion');
