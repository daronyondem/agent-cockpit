import http from 'http';
import fs from 'fs';
import path from 'path';
import type { CopilotWorkflowPlan } from './copilotWorkflowEnv';

interface FixtureMessage { role: string; content?: unknown; tool_calls?: Array<{ function: { name: string } }> }
interface FixtureRequest { messages: FixtureMessage[]; tools?: Array<{ function?: { name: string } }> }

/** Fixed model responses exercise the real CLI/tools without a hosted account. */
export async function createCopilotLocalProvider(getPlan: () => CopilotWorkflowPlan, workspace: string, marker: string) {
  let toolSerial = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data.toString(); });
    req.on('end', () => {
      try {
        const request = JSON.parse(body) as FixtureRequest;
        const text = request.messages.filter(message => message.role !== 'tool').map(message => JSON.stringify(message.content)).join('\n');
        const plan = getPlan();
        const memory = text.includes('You are the Memory Librarian');
        const context = text.includes('# Workspace Context Maintenance') || text.includes('# Workspace Context Catch-Up');
        const reply = (delta: object, reason: string) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const [part, finish] of [[delta, null], [{}, reason]]) {
            res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4', choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
          }
          res.end('data: [DONE]\n\n');
        };
        const say = (content: string) => reply({ role: 'assistant', content }, 'stop');
        const call = (suffix: string, args: object) => {
          const tool = request.tools?.find(item => item.function?.name.endsWith(suffix));
          if (!tool?.function) throw new Error(`Fixture tool unavailable: ${suffix}`);
          reply({ role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${suffix}-${++toolSerial}`, type: 'function', function: {
            name: tool.function.name, arguments: JSON.stringify(args),
          } }] }, 'tool_calls');
        };
        const hold = (name: string, send: () => void) => {
          fs.writeFileSync(path.join(workspace, `ui-${name}-ready`), 'ready');
          const timer = setInterval(() => {
            if (!fs.existsSync(path.join(workspace, `ui-${name}-release`))) return;
            clearInterval(timer); send();
          }, 20);
          res.on('close', () => clearInterval(timer));
        };
        if ((memory && plan.memoryError) || (context && plan.contextError)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Fixture processor failed', type: 'invalid_request_error' } }));
          return;
        }
        if (memory) { say(plan.memoryOutput); return; }
        if (text.includes('Summarize this conversation in one concise paragraph.')) { say('Fixture session summary.'); return; }
        if (text.includes('Generate a concise conversation title')) { say('Copilot fixture chat'); return; }
        if (context) {
          if (plan.contextWait) return;
          if (!plan.destination || request.messages.some(message => message.role === 'tool')) { say(plan.contextOutput); return; }
          const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
          const program = `const fs = require('fs');
const plan = ${JSON.stringify(plan)};
if (!fs.readFileSync(${JSON.stringify(path.join(workspace, 'AGENTS.md'))}, 'utf8').includes(plan.instructions)) throw new Error('Missing Context instruction pointer');
fs.readFileSync(plan.instructions, 'utf8');
fs.writeFileSync(plan.destination, '# Fixture project\\n\\n' + plan.sources.map(file => fs.readFileSync(file, 'utf8')).join('\\n\\n'));
console.log('Updated fixture context from listed sources.');`;
          call('bash', { command: `${quote(process.execPath)} -e ${quote(program)}`, description: 'Update synthetic Context markdown', initial_wait: 1000 });
          return;
        }
        const toolMessages = request.messages.filter(message => message.role === 'tool');
        const lastUser = String(request.messages.filter(message => message.role === 'user').at(-1)?.content || '');
        if (text.includes('COPILOT_UI_GOAL')) {
          if (text.includes('COPILOT_UI_GOAL_PAUSE') && !fs.existsSync(path.join(workspace, 'ui-goal-release'))) {
            const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
            const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-goal-worker.pid'))},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-goal-worker-finished'))},'unexpected'),45000);`;
            call('bash', { command: `${quote(process.execPath)} -e ${quote(program)}`, description: 'Goal checkpoint worker', initial_wait: 1000 });
          } else call('task_complete', { summary: 'COPILOT_UI_GOAL_VERIFIED' });
          return;
        }
        const child = /COPILOT_UI_CHILD_(BACKGROUND|STOP)$/.exec(lastUser)?.[1];
        if (child) {
          if (!toolMessages.length) {
            const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
            const program = `const fs=require('fs');
fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-delegate-worker.pid.tmp'))},String(process.pid));
fs.renameSync(${JSON.stringify(path.join(workspace, 'ui-delegate-worker.pid.tmp'))},${JSON.stringify(path.join(workspace, 'ui-delegate-worker.pid'))});
setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-delegate-worker-finished'))},'unexpected'),45000);`;
            call('bash', { command: child === 'STOP' ? `${quote(process.execPath)} -e ${quote(program)}` : 'echo COPILOT_UI_CHILD_TOOL',
              description: 'Delegated synthetic command', initial_wait: 1000 });
          } else if (child === 'BACKGROUND') hold('delegate', () => say('COPILOT_UI_CHILD_SUMMARY'));
          else say('COPILOT_UI_CHILD_UNEXPECTED');
          return;
        }
        if (text.includes('COPILOT_UI_REPLY')) { say('COPILOT_UI_REPLY_OK'); return; }
        if (text.includes('COPILOT_UI_DELEGATE')) {
          if (toolMessages.length) say('COPILOT_UI_DELEGATE_PARENT_OK');
          else {
            const stop = text.includes('COPILOT_UI_DELEGATE_STOP');
            call('task', { name: 'copilot-ui-child', agent_type: 'general-purpose', description: 'Run delegated browser fixture',
              prompt: stop ? 'COPILOT_UI_CHILD_STOP' : 'COPILOT_UI_CHILD_BACKGROUND', ...(stop ? {} : { mode: 'background' }) });
          }
          return;
        }
        if (text.includes('COPILOT_UI_QUESTION')) {
          const ask = () => call('ask_user', { question: 'Choose the fixture answer', choices: ['Alpha', 'Beta'] });
          if (text.includes('COPILOT_UI_QUESTION_LATE') && !toolMessages.length) hold('question', ask);
          else if (toolMessages.length < 2) ask();
          else say('COPILOT_UI_QUESTION_OK ' + JSON.stringify(toolMessages.at(-1)?.content));
          return;
        }
        if (text.includes('COPILOT_UI_STEER')) {
          if (toolMessages.length) { say(text.includes('COPILOT_UI_CORRECTION') ? 'COPILOT_UI_STEER_OK' : 'COPILOT_UI_STEER_MISSING'); return; }
          hold('input', () => {
            if (text.includes('COPILOT_UI_STEER_BOUNDARY')) say('COPILOT_UI_BOUNDARY_DONE');
            else call('bash', { command: 'echo COPILOT_UI_STEER_CHECKPOINT', description: 'Synthetic steering checkpoint', initial_wait: 1000 });
          });
          return;
        }
        if (text.includes('COPILOT_UI_WAIT')) {
          if (toolMessages.length) { say('COPILOT_UI_WAIT_DONE'); return; }
          const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
          const program = `const fs=require('fs');
fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-worker.pid.tmp'))},String(process.pid));
fs.renameSync(${JSON.stringify(path.join(workspace, 'ui-worker.pid.tmp'))},${JSON.stringify(path.join(workspace, 'ui-worker.pid'))});
setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'ui-worker-finished'))},'unexpected'),45000);`;
          call('bash', { command: `${quote(process.execPath)} -e ${quote(program)}`, description: 'Run synthetic cancellable work', initial_wait: 1000 });
          return;
        }
        if (text.includes('WORKFLOW_CONTEXT_RECALL_ONLY') && toolMessages.length === 0) {
          const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
          const program = `const fs=require('fs');
if (!fs.readFileSync(${JSON.stringify(path.join(workspace, 'AGENTS.md'))},'utf8').includes(${JSON.stringify(plan.instructions)})) throw new Error('Missing Context pointer');
fs.readFileSync(${JSON.stringify(plan.instructions)},'utf8');
console.log(fs.readFileSync(${JSON.stringify(plan.destination)},'utf8'));`;
          call('bash', { command: `${quote(process.execPath)} -e ${quote(program)}`, description: 'Read synthetic Workspace Context', initial_wait: 1000 });
          return;
        }
        if (toolMessages.length === 0) {
          if (text.includes('WORKFLOW_RECALL_ONLY')) call('memory_search', { query: marker });
          else call('memory_note', { content: `The permanent project identifier is ${marker}.`, type: 'project' });
        } else if (toolMessages.length === 1 && JSON.stringify(toolMessages[0].content).includes('Memory note saved:')) {
          call('memory_search', { query: marker });
        } else {
          say(JSON.stringify(toolMessages.at(-1)?.content));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: (err as Error).message } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
