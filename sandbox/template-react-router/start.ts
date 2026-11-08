const port = process.argv[2];
if (!port) throw new Error('Expected a port');
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = port;
process.argv = [process.argv[0], 'react-router-serve', 'build/server/index.js'];
await import('./node_modules/@react-router/serve/bin.js');
