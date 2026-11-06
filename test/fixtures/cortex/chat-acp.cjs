#!/usr/bin/env node
// Deterministic process fixture, never native compatibility evidence.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
if (process.argv.includes('--version')) { process.stdout.write('Cortex Code v1.2.35\n'); process.exit(0); }
const stateFile = process.env.CORTEX_FIXTURE_STATE;
const trace = process.env.CORTEX_FIXTURE_TRACE;
const catalog = [
  { id: 'model', type: 'select', currentValue: 'auto', options: ['auto', 'claude-sonnet-4-6'].map(value => ({ value, name: value })) },
  { id: 'thought_level', type: 'select', currentValue: 'auto', options: ['auto', 'low', 'medium', 'high'].map(value => ({ value, name: value })) },
  { id: 'mode', type: 'select', currentValue: 'standard', options: ['standard', 'plan'].map(value => ({ value, name: value })) },
];
let sessionId;
let pending;
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const update = value => send({ method: 'session/update', params: { sessionId, update: value } });
const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const write = value => fs.writeFileSync(stateFile, JSON.stringify(value));
function finish(text) {
  const request = pending; pending = undefined;
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  send({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0 } } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (trace && request.method) fs.appendFileSync(trace, JSON.stringify({ method: request.method, params: request.params, pid: process.pid }) + '\n');
  const reply = result => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    case 'session/new': {
      sessionId = crypto.randomUUID(); const state = read(); state[sessionId] = {}; write(state);
      return reply({ sessionId, configOptions: catalog });
    }
    case 'session/load': {
      sessionId = request.params.sessionId;
      if (!read()[sessionId]) return send({ id: request.id, error: { code: -32603, message: 'Internal error', data: { details: `Failed to load session ${sessionId}: Session '${sessionId}' not found` } } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } });
      return reply({ configOptions: catalog });
    }
    case 'session/set_config_option':
      catalog.find(row => row.id === request.params.configId).currentValue = request.params.value;
      return reply({ configOptions: catalog });
    case 'session/prompt': {
      pending = request;
      const text = request.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text.includes('fixture-wait')) return;
      if (text.includes('fixture-question')) return send({ id: 'question-native-rpc', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'native-tool', title: 'Choose a fixture color', kind: 'other' },
        options: [{ optionId: 'blue', name: 'Blue', kind: 'allow_once' }, { optionId: 'green', name: 'Green', kind: 'allow_once' }],
        _meta: { questionIndex: 0, totalQuestions: 1 } } });
      const remember = text.match(/fixture-remember:(\w+)/);
      if (remember) { const state = read(); state[sessionId].nonce = remember[1]; write(state); }
      if (text.includes('fixture-deliver')) {
        const file = path.join(process.cwd(), 'report.txt'); fs.writeFileSync(file, 'FIXTURE_ARTIFACT');
        update({ sessionUpdate: 'tool_call', toolCallId: 'write-report', title: 'write', kind: 'edit', status: 'completed', rawInput: { file_path: file } });
        return finish(`Delivered\n<!-- FILE_DELIVERY:${file} -->`);
      }
      return finish(text.includes('fixture-recall') ? read()[sessionId].nonce || 'MISSING' : 'ANSWER');
    }
    case 'session/cancel': {
      if (pending) { const request = pending; pending = undefined; send({ id: request.id, result: { stopReason: 'cancelled' } }); }
      return;
    }
    case 'session/close': return reply({});
    default:
      if (request.id === 'question-native-rpc' && pending) return finish('CHOICE_' + request.result.outcome.optionId);
  }
});
