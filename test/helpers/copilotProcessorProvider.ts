import path from 'path';

export interface CopilotProcessorPlan {
  digest: string;
  glean: string;
  dream: string;
  routine: string;
  wait?: boolean;
  error?: boolean;
}

/** Fixed model decisions; file access and output creation still run in native tools. */
export function replyToCopilotProcessor(
  messages: Array<{ role: string; content?: unknown }>,
  plan: CopilotProcessorPlan,
  workspace: string,
  say: (content: string) => void,
  call: (name: string, args: object) => void,
): boolean {
  const prompt = messages.filter(message => message.role !== 'tool')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  const phase = prompt.includes('## Routine Markdown') ? 'routine'
    : prompt.includes('# Knowledge Base gleaning pass') ? 'glean'
      : prompt.includes('# Knowledge Base digestion request') ? 'digest'
        : prompt.includes('— read at entries/') ? 'dream' : null;
  if (!phase) return false;
  if (plan.error) throw new Error('Fixture processor failure');
  if (phase === 'glean') {
    if (!prompt.includes('## Response 1') || !prompt.includes('COPILOT_KB_571')) throw new Error('Gleaning lost the first response');
    say(plan.glean);
    return true;
  }
  const toolMessages = messages.filter(message => message.role === 'tool');
  if (toolMessages.length) {
    if (plan.wait) return true;
    if (!JSON.stringify(toolMessages).includes(`COPILOT_PROCESSOR_OK:${phase}`)) throw new Error(`Native ${phase} tool did not verify its files`);
    say(plan[phase]);
    return true;
  }
  let program = `const fs=require('fs');const path=require('path');\n`;
  if (plan.wait) {
    program += `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(path.join(workspace, 'processor-worker.json'))},JSON.stringify({pid:process.pid,childPid:child.pid}));
setTimeout(()=>fs.writeFileSync(${JSON.stringify(path.join(workspace, 'processor-worker-finished'))},'unexpected'),45000);`;
  } else {
    const sources = phase === 'digest' ? [prompt.match(/^- Converted text \(relative to knowledge\/\): (.+)$/m)?.[1]]
      : phase === 'routine' ? [prompt.match(/^Routine file: (.+)$/m)?.[1]]
        : [...prompt.matchAll(/— read at (entries\/[^\n]+)/g)].map(match => match[1]);
    if (!sources.length || sources.some(source => !source)) throw new Error(`Missing ${phase} source paths`);
    const destination = phase === 'routine' ? prompt.match(/^Output folder: (.+)$/m)?.[1] : undefined;
    if (phase === 'routine' && !destination) throw new Error('Missing Routine output folder');
    program += `const sources=${JSON.stringify(sources)};
for(const source of sources) if(!fs.readFileSync(source,'utf8').includes(${JSON.stringify(phase === 'routine' ? 'COPILOT_ROUTINE_571' : 'COPILOT_KB_571')})) throw new Error('Missing real processor source');
${destination ? `fs.writeFileSync(path.join(${JSON.stringify(destination)},'fixture.txt'),'COPILOT_ROUTINE_571');` : ''}
fs.appendFileSync(${JSON.stringify(path.join(workspace, 'processor-proof.jsonl'))},JSON.stringify({phase:${JSON.stringify(phase)},sources,cwd:process.cwd(),destination:${JSON.stringify(destination) ?? 'null'}})+'\\n');
console.log(${JSON.stringify(`COPILOT_PROCESSOR_OK:${phase}`)});`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  call('bash', { command: `${quote(process.execPath)} -e ${quote(program)}`, description: `Verify synthetic ${phase} workflow files`, initial_wait: 1000 });
  return true;
}
