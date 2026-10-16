const assert = require('node:assert/strict');
const http = require('node:http');
let socket;
let wasWritable;
const server = http.createServer((req, res) => {
  socket = res.socket;
  assert.equal(req.socket, socket);
  wasWritable = socket.writable;
  res.end(wasWritable ? 'writable response' : 'not writable');
});
server.listen(0, '127.0.0.1', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { connection: 'close' } });
  const body = await response.text();
  server.close(() => {
    assert.equal(wasWritable, true);
    assert.equal(body, 'writable response');
    assert.equal(socket.writable, false);
    console.log('socket lifecycle');
  });
});
