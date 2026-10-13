// A server that behaves like `ai.ankimcp/anki-mcp-server`: it prints an HTTP
// banner on stdout, never reads stdin, and stays alive.
//
// Verified against the real package on 2026-10-13: the registry declares
// `packages[0].transport.type: "stdio"` for it, while the package actually binds
// http://127.0.0.1:3000 and answers nothing on stdio. An optional argv[2] makes
// it write its own pid there, so a test can prove it was really killed.
import fs from 'node:fs';

if (process.argv[2]) fs.writeFileSync(process.argv[2], String(process.pid));
console.log('Server running on: http://127.0.0.1:3000');
console.log('AnkiConnect URL:   http://localhost:8765');
setInterval(() => {}, 1000);
