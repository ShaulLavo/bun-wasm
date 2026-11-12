const port = process.argv[2];
if (!port) throw new Error('Expected a port');
process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = port;
process.env.NITRO_HOST = '127.0.0.1';
process.env.NITRO_PORT = port;
await import('./dist/server/entry.mjs');
