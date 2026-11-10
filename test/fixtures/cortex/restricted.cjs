#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  if (process.env.C35_FIXTURE_REMOVE_SCRIPT) fs.unlinkSync(__filename);
  console.log('Cortex Code v' + (process.env.C35_FIXTURE_VERSION || '1.2.35')); process.exit(0);
}
const session = 'restricted-fixture';
const trace = data => { if (process.env.C35_FIXTURE_TRACE) fs.appendFileSync(process.env.C35_FIXTURE_TRACE, JSON.stringify(data) + '\n'); };
const send = row => process.stdout.write(JSON.stringify({ session_id: session, ...row }) + '\n');
trace({ kind: 'start', args, cwd: process.cwd(), home: process.env.CORTEX_HOME,
  controls: { mode: process.env.CORTEX_AGENT_MODE, skills: process.env.CORTEX_DISABLE_BUNDLED_SKILLS, memory: process.env.CORTEX_ENABLE_MEMORY },
  hooks: JSON.parse(fs.readFileSync(path.join(process.env.CORTEX_HOME, 'hooks.json'), 'utf8')) });
if (process.env.C35_FIXTURE_INIT === 'hold') setInterval(() => {}, 1000);
else send({ type: 'system', subtype: 'init', tools: process.env.C35_FIXTURE_INIT === 'tools' ? ['read'] : [], skills: [], mcp_servers: [], plugins: [], slash_commands: [] });
let remembered = '';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const wrapped = request.message.content[0].text;
  trace({ kind: 'prompt', request });
  const text = JSON.parse(wrapped.slice(wrapped.indexOf('\n') + 1));
  if (text === 'hold') return;
  if (text === 'tool') return send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'forbidden', name: 'read', input: {} }] } });
  if (text === 'control') return send({ type: 'control_request', request_id: 'never', request: { subtype: 'can_use_tool' } });
  if (text === 'malformed') return process.stdout.write('not-json\n');
  if (text === 'exit') return process.exit(1);
  if (text.startsWith('remember:')) remembered = text.slice(9);
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'RESPONSE' }] } });
  send({ type: 'result', uuid: require('crypto').randomUUID(), subtype: text === 'failure' ? 'error_during_execution' : 'success', is_error: false, num_turns: 1,
    result: text === 'recall' ? remembered : 'ANSWER', permission_denials: [],
    ...(text === 'partial' ? {} : { usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) });
});
