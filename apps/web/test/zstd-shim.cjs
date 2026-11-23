// Preloaded into Vitest's forks workers (see vitest.config.ts).
//
// jsdom depends on undici, whose decompress interceptor does
// `createZstdDecompress.bind(...)` at require time. node:zlib only gained
// the Zstandard API in Node 22.15, so on older supported runtimes (22.13)
// the bind throws and the test worker dies before any test file loads.
// jsdom never negotiates `content-encoding: zstd` in the test suite, so a
// throwing stub keeps the require path working without touching deps.
const zlib = require('node:zlib');

if (zlib.createZstdDecompress === undefined) {
  zlib.createZstdDecompress = function createZstdDecompress() {
    throw new Error('zstd decompression requires Node >= 22.15');
  };
}
