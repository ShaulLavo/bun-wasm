const assert = require('node:assert/strict');
const http = require('node:http');
let socket;
const server = http.createServer((req, res) => {
  socket = res.socket;
  assert.equal(req.socket, socket);
  assert.equal(socket.writable, true);
  res.end('writable response');
});
server.listen(0, '127.0.0.1', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { connection: 'close' } });
  assert.equal(await response.text(), 'writable response');
  server.close(() => {
    assert.equal(socket.writable, false);
    console.log('socket lifecycle');
  });
});
