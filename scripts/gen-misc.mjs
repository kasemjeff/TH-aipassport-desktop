const fs = require('fs');
const src = fs.readFileSync('desktop/ui/app_head_utf8.js', 'utf8');
const lines = src.split(/\r?\n/);
function findFn(name){ for(let i=0;i<lines.length;i++){ if(new RegExp('async function '+name+'\\(').test(lines[i])) return i; } return -1; }
const memStart = findFn('showMemory');
const goalStart = findFn('showGoal');
const mcpStart = findFn('showMcp');
const symStart = findFn('showSymbols');
let symEnd = symStart;
for(let i=symStart+1;i<lines.length;i++){ if(/^async function |^function |^const \w+ = \(/.test(lines[i])){ symEnd=i-1; break; }
const parts = [
  lines.slice(memStart, goalStart),
  lines.slice(goalStart, mcpStart),
  lines.slice(mcpStart, symStart),
  lines.slice(symStart, symEnd+1),
];
let block = parts.join('\n');
block = block.replace(/\bstate\./g,'ctx.state.')
  .replace(/\brpc\(/g,'ctx.rpc(')
  .replace(/\baddNote\(/g,'ctx.addNote(')
  .replace(/\baddCommandOut\(/g,'ctx.addCommandOut(')
  .replace(/\bfriendly\(/g,'ctx.friendly(');
const showIndex = [
'async function showIndex(arg) {',
'  const verb = String(arg || "").trim().toLowerCase();',
'  if (verb === "clear") {',
'    const res = await ctx.rpc("retrieval.clear").catch((err) => ({ error: err.message }));',
'    if (res && res.error) { ctx.addCommandOut("index: " + ctx.friendly(res.error)); return; }',
'    ctx.addCommandOut("index cleared - it rebuilds on the next RETRIEVE.");',
'    return;',
'  }',
'  const st = await ctx.rpc("retrieval.status").catch((err) => ({ error: err.message }));',
'  if (st && st.error) { ctx.addCommandOut("index: " + ctx.friendly(st.error)); return; }',
'  ctx.addCommandOut("index: " + st.files + " files, " + st.chunks + " passages, " + Math.round((st.bytes || 0) / 1024) + " KB.");',
'}',
].join('\n');
block = block + '\n' + showIndex;
const header = '// Misc command handlers (memory, goal, mcp, symbols, index).\nexport function createMiscCommands(ctx) {\n';
const footer = '\n  return { showMemory, showGoal, showMcp, showSymbols, showIndex };\n}\n';
const content = header + block + footer;
fs.writeFileSync('desktop/ui/features/misc-commands.js', content, 'utf8');
console.log('written', content.length);