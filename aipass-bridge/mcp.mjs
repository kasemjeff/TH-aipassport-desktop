#!/usr/bin/env node
// aipass mcp — inspect configured MCP servers and their tools.
//
//   aipass mcp            list servers + tools (connects to each)
//   aipass mcp call <marker> [json-args]   call one tool
import { McpManager } from './harness/mcp.mjs';
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const root = process.cwd();
const mcp = new McpManager({ root, log: (t) => console.error(t) });
await mcp.ensureLoaded();
if (cmd === 'list' || cmd === 'ls') {
  const tools = mcp.toolTable();
  if (!tools.length) { console.log('(no MCP servers configured — add ~/.aipass/mcp.json)'); process.exit(0); }
  console.log(`${mcp.clients.size} server(s), ${tools.length} tool(s):`);
  for (const t of tools) console.log(`  ${t.marker}  ${t.description}`);
  process.exit(0);
}
if (cmd === 'call') {
  const marker = argv[1];
  if (!marker) { console.error('usage: aipass mcp call <marker> [json-args]'); process.exit(1); }
  const args = argv[2] ? JSON.parse(argv[2]) : {};
  console.log(await mcp.runTool(marker, { body: JSON.stringify(args) }));
  process.exit(0);
}
console.log('usage: aipass mcp [list|call <marker> [json]]');
process.exit(1);
