import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
const server = createServer((req,res) => { console.log(req.url); res.end('ok'); });
await once(server.listen(0,'127.0.0.1'),'listening');
const socket=connect({port:server.address().port,host:'127.0.0.1'});
let output='';
let done=Promise.withResolvers<void>();
socket.on('data',data=> {output+=data.toString(); if(output.split('HTTP/1.1 200').length===3)done.resolve();});
const deadline=setTimeout(()=>done.reject(new Error('second response missing')),1000);
try {
 await once(socket,'connect');
 socket.write('POST /ignored HTTP/1.1\r\nHost: localhost\r\nContent-Length: 131072\r\n\r\n');
 socket.write(Buffer.alloc(131072,120));
 socket.write('GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n');
 await done.promise;
 console.log('two responses');
} finally {clearTimeout(deadline);socket.destroy();server.closeAllConnections();server.close();}
