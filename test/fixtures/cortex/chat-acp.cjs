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
  if (process.env.CORTEX_FIXTURE_USAGE) update({ sessionUpdate: 'usage_update', size: 100, used: 25 });
  send({ id: request.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2,
    cachedReadTokens: process.env.CORTEX_FIXTURE_USAGE ? 17 : 0, cachedWriteTokens: process.env.CORTEX_FIXTURE_USAGE ? 19 : 0 } } });
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
      if (process.env.CORTEX_FIXTURE_CONTEXT_MODE && text.startsWith('# Workspace Context')) {
        const mode = process.env.CORTEX_FIXTURE_CONTEXT_MODE;
        const directory = text.match(/^Workspace Context markdown folder: (.+)$/m)[1];
        const section = text.split('## Memory Inbox Files\n')[1] || '';
        const entries = [...section.matchAll(/^- ([^\n]+\.md): (.+)$/gm)];
        fs.writeFileSync(path.join(directory, 'fixture-context.md'), '# Fixture Context\nCONTEXT_FIXTURE_UPDATED\n');
        if (mode === 'missing-actions') return finish('Updated fixture-context.md.');
        const acceptedMemoryFiles = mode === 'unknown-actions' ? ['notes/unknown.md'] : entries.map(entry => entry[1]);
        const block = '```workspace-context-memory-actions\n' + JSON.stringify({ acceptedMemoryFiles }) + '\n```';
        return finish('Updated fixture-context.md.\n' + (entries.length ? block + (mode === 'duplicate-actions' ? '\n' + block : '') : ''));
      }
      if (process.env.CORTEX_FIXTURE_ROUTINE_ITEMS && text.includes('fixture-propose-routine')) {
        const directory = path.join(process.env.CORTEX_FIXTURE_ROUTINE_ITEMS, 'fixture-radar'); fs.mkdirSync(directory, { recursive: true });
        const manifest = { schemaVersion: 1, kind: 'agent-cockpit.routine', id: 'fixture-radar', title: 'Fixture Radar',
          routineFile: 'routine.md', state: 'proposed', trigger: { type: 'manual' },
          harness: { cliProfileId: process.env.CORTEX_FIXTURE_PROFILE_ID, model: 'claude-sonnet-4-6', effort: 'medium' },
          timeoutMinutes: 1, notification: { mode: 'workspaceDefault' } };
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(directory, 'routine.md'), '# Fixture Radar\nWrite the fixture output and notification.\n');
        return finish(`Proposed\n<!-- AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:${path.join(directory, 'manifest.json')} -->`);
      }
      if (process.env.CORTEX_FIXTURE_ROUTINE_ITEMS && text.startsWith('# Agent Cockpit Routine Execution')) {
        const field = label => text.match(new RegExp('^' + label + ': (.+)$', 'm'))[1];
        const persistent = path.join(field('Persistent state folder'), 'cursor.json');
        const previous = fs.existsSync(persistent) ? JSON.parse(fs.readFileSync(persistent, 'utf8')).count : 0;
        fs.writeFileSync(persistent, JSON.stringify({ count: previous + 1 }));
        fs.writeFileSync(path.join(field('Output folder'), 'report.txt'), 'ROUTINE_FIXTURE_OUTPUT');
        fs.writeFileSync(path.join(field('Temporary folder'), 'scratch.txt'), 'SCRATCH');
        fs.writeFileSync(field('Notification file'), 'ROUTINE_FIXTURE_NOTIFY');
        if (text.includes('fixture-routine-hold')) return;
        return finish('ROUTINE_FIXTURE_DONE');
      }
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
