// A minimal LSP server for tests. Speaks Content-Length framing, answers
// initialize, and publishes one diagnostic on didOpen.
import { createInterface } from 'node:readline';

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const header = buffer.slice(0, idx).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buffer = buffer.slice(idx + 4); continue; }
    const len = Number(m[1]);
    const start = idx + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params?.textDocument?.uri;
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
        uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 1, message: 'boom', source: 'echo-lsp' }],
      } });
    }, 50);
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
}