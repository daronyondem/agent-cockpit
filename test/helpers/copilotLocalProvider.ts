import http from 'http';
import path from 'path';
import type { CopilotWorkflowPlan } from './copilotWorkflowEnv';

interface FixtureMessage { role: string; content?: unknown; tool_calls?: Array<{ function: { name: string } }> }
interface FixtureRequest { messages: FixtureMessage[]; tools?: Array<{ function?: { name: string } }> }

/** Fixed model responses exercise the real CLI/tools without a hosted account. */
export async function createCopilotLocalProvider(getPlan: () => CopilotWorkflowPlan, workspace: string, marker: string) {
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
          reply({ role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${suffix}`, type: 'function', function: {
            name: tool.function.name, arguments: JSON.stringify(args),
          } }] }, 'tool_calls');
        };
        if ((memory && plan.memoryError) || (context && plan.contextError)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Fixture processor failed', type: 'invalid_request_error' } }));
          return;
        }
        if (memory) { say(plan.memoryOutput); return; }
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
