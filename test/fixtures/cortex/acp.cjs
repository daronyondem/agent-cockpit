#!/usr/bin/env node
// Deterministic process fixture. Native compatibility uses the opt-in real CLI probe.
const readline = require('readline');
if (process.argv[2] === '--version') {
  process.stdout.write(process.env.FIXTURE_BAD_VERSION ? 'unknown\n' : 'Cortex Code v1.2.35\n');
  process.exit(0);
}
let prompts = 0;
let pending;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const update = text => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') reply(frame.id, { protocolVersion: process.env.FIXTURE_BAD_PROTOCOL ? 2 : 1, agentInfo: { version: '1.0.0' } });
  else if (frame.method === 'session/new' || frame.method === 'session/load') {
    if (process.env.FIXTURE_CATALOG_FAIL) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'catalog unavailable' } }) + '\n');
    } else {
      if (frame.method === 'session/load') update('REPLAY');
      reply(frame.id, { sessionId: 'fixture-session', configOptions: [{ id: 'model', options: [{ value: process.env.FIXTURE_MODEL || 'model-a' }] }] });
    }
  } else if (frame.method === 'session/prompt') {
    prompts++;
    if (frame.params.prompt[0].text === 'wait') pending = frame.id;
    else { update('OK'); reply(frame.id, { stopReason: 'end_turn' }); }
  } else if (frame.method === 'session/cancel') {
    if (!process.env.FIXTURE_IGNORE_CANCEL && pending) { reply(pending, { stopReason: 'cancelled' }); pending = undefined; }
  } else if (frame.method === 'session/close') reply(frame.id, {});
  else if (frame.method === '_test/state') reply(frame.id, { argv: process.argv.slice(2), cwd: process.cwd(), prompts,
    memory: process.env.CORTEX_ENABLE_MEMORY, test: process.env.CORTEX_ACP_TEST_MODE, manual: process.env.CORTEX_OAUTH_MANUAL });
});
