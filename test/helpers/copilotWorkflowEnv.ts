import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CopilotAdapter } from '../../src/services/backends/copilot';
import type { McpServerConfig } from '../../src/types';
import { createChatRouterEnv, destroyChatRouterEnv } from './chatEnv';
import { createCopilotLocalProvider } from './copilotLocalProvider';

export const MEMORY_MARKER = 'COPILOT_MEMORY_571';
export const REFERENCE_MARKER = 'COPILOT_CONTEXT_571';

export interface CopilotWorkflowPlan {
  memoryOutput: string;
  memoryError?: boolean;
  contextOutput: string;
  contextError?: boolean;
  contextWait?: boolean;
  contextRelease?: string;
  sources: string[];
  destination?: string;
  instructions?: string;
}

export async function createCopilotWorkflowEnv(native = false) {
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const previousPort = process.env.PORT;
  const nativeKeys = ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_MODEL',
    'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'COPILOT_DISABLE_KEYTAR'];
  const previousNativeEnv = Object.fromEntries(nativeKeys.map(key => [key, process.env[key]]));
  process.env.PORT = String((env.server.address() as { port: number }).port);
  const workspace = path.join(env.tmpDir, 'workspace');
  const planPath = path.join(env.tmpDir, 'copilot-plan.json');
  const callsPath = path.join(env.tmpDir, 'copilot-calls.jsonl');
  const launcher = path.join(env.tmpDir, 'copilot-workflow');
  const profileId = 'copilot-workflows';
  const model = native ? 'gpt-4' : 'gpt-6.1-sol';
  const plan: CopilotWorkflowPlan = {
    memoryOutput: JSON.stringify({ action: 'saved', reason: 'Durable fixture project rule.', entry:
      `---\nname: fixture-project-rule\ndescription: Fixture project identifier\ntype: project\n---\n\nThe permanent project identifier is ${MEMORY_MARKER}.` }),
    contextOutput: 'No context changes needed.', sources: [],
  };
  const writePlan = () => { fs.writeFileSync(planPath, JSON.stringify(plan)); };
  let provider: Awaited<ReturnType<typeof createCopilotLocalProvider>> | undefined;
  const close = async () => {
    try {
      await env.backendRegistry.shutdownAll();
      await destroyChatRouterEnv(env);
    } finally {
      await provider?.close();
      if (native) for (const key of nativeKeys) {
        if (previousNativeEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousNativeEnv[key];
      }
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  };
  try {
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `# Fixture instructions\nOnly use synthetic data under ${env.tmpDir}. If Memory fails, report the error and do not write fallback memory files.\n`);
    writePlan();
    const record = `require('fs').appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),pid:process.pid})+'\\n');`;
    if (native) {
      provider = await createCopilotLocalProvider(() => plan, workspace, MEMORY_MARKER);
      Object.assign(process.env, { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: provider.baseUrl, COPILOT_PROVIDER_API_KEY: '', COPILOT_MODEL: 'gpt-4',
        COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: path.join(env.tmpDir, 'gh'), COPILOT_DISABLE_KEYTAR: '1' });
      fs.writeFileSync(launcher, `#!${process.execPath}
${record}
const result = require('child_process').spawnSync('copilot', [...process.argv.slice(2), '--disable-client-telemetry', '--disable-builtin-mcps'], {
  stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(env.tmpDir)}, COPILOT_HOME: ${JSON.stringify(path.join(env.tmpDir, 'copilot-home'))},
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: ${JSON.stringify(provider.baseUrl)}, COPILOT_MODEL: 'gpt-4' }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
    } else {
      fs.writeFileSync(launcher, `#!${process.execPath}
const fs = require('fs');
${record}
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const memory = prompt.includes('You are the Memory Librarian');
const context = /Workspace Context (Catch-Up|Maintenance)/.test(prompt);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));
if (context && plan.contextWait) {
  const timer = setInterval(() => {
    if (plan.contextRelease && fs.existsSync(plan.contextRelease)) { clearInterval(timer); complete(); }
  }, 10);
} else complete();
function complete() {
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));
if ((memory && plan.memoryError) || (!memory && plan.contextError)) { console.error('Fixture processor failed'); process.exit(1); }
if (context && plan.destination) {
  if (!args.includes('--allow-all')) throw new Error('Context tools unavailable');
  if (!fs.readFileSync(require('path').join(process.cwd(),'AGENTS.md'),'utf8').includes(plan.instructions)) throw new Error('Missing Context instruction pointer');
  fs.readFileSync(plan.instructions,'utf8');
  fs.writeFileSync(plan.destination, '# Fixture project\\n\\n' + plan.sources.map(file => fs.readFileSync(file,'utf8')).join('\\n\\n'));
}
const output = memory ? plan.memoryOutput : context ? plan.contextOutput : 'Fixture session summary.';
console.log(JSON.stringify({type:'assistant.message',data:{messageId:'fixture-final',content:output}}));
console.log(JSON.stringify({type:'result',exitCode:0,usage:{}}));
}
`);
    }
    fs.chmodSync(launcher, 0o755);
    const adapter = new CopilotAdapter({ workingDir: workspace });
    env.backendRegistry.register(adapter);
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), defaultBackend: 'copilot', defaultCliProfileId: profileId,
      cliProfiles: [{ id: profileId, name: 'Copilot workflows', harness: 'copilot', authMode: 'server-configured', command: launcher, createdAt: '', updatedAt: '' }],
      memory: { cliProfileId: profileId, cliModel: model },
      workspaceContext: { cliProfileId: profileId, cliModel: model, scanIntervalMinutes: 1440, cliConcurrency: 1 },
    });
    const conv = await env.chatService.createConversation('Fixture conversation', workspace, 'copilot', model, undefined, profileId);
    await env.chatService.setWorkspaceMemoryEnabled(conv.workspaceId, true);
    return { ...env, adapter, workspace, conv, plan, writePlan, callsPath, profileId, model, close };
  } catch (err) {
    await close();
    throw err;
  }
}

export type CopilotWorkflowEnv = Awaited<ReturnType<typeof createCopilotWorkflowEnv>>;

export async function saveWorkflowNote(env: CopilotWorkflowEnv): Promise<string> {
  const server = env.memoryMcp.issueMemoryMcpSession(env.conv.id, env.conv.workspaceId).mcpServers[0];
  const result = await callMemory(server, 'memory_note', { content: `The permanent project identifier is ${MEMORY_MARKER}.`, type: 'project' });
  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain('Memory note saved:');
  const file = (await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files.find(item => item.content.includes(MEMORY_MARKER));
  if (!file) throw new Error('Governed Memory note was not persisted');
  return file.filename;
}

export async function prepareWorkflowContext(env: CopilotWorkflowEnv, accepted: string[]): Promise<void> {
  const service = env.workspaceContextService;
  await env.chatService.setWorkspaceContextEnabled(env.conv.workspaceId, true);
  await service.ensureWorkspace(env.conv.workspaceId);
  const reference = path.join(service.getReferenceFilesDir(env.conv.workspaceId), 'fixture.md');
  fs.writeFileSync(reference, `# Reference\nThe durable reference identifier is ${REFERENCE_MARKER}.\n`);
  env.plan.instructions = service.getInstructionPath(env.conv.workspaceId);
  env.plan.destination = path.join(service.getContextFilesDir(env.conv.workspaceId), 'projects.md');
  env.plan.sources = [reference, ...accepted.map(name => path.join(env.chatService.getWorkspaceMemoryFilesDir(env.conv.workspaceId), name))];
  env.plan.contextOutput = `Updated projects.md from the listed sources.\n\n\`\`\`workspace-context-memory-actions\n${JSON.stringify({ acceptedMemoryFiles: accepted })}\n\`\`\``;
  env.writePlan();
}

export interface MemoryToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }

export async function callMemory(server: McpServerConfig, name: string, args: Record<string, unknown>): Promise<MemoryToolResult> {
  const env = { ...process.env, ...Object.fromEntries((server.env || []).map(item => [item.name, item.value])) };
  const proc = spawn(process.execPath, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`Memory stub timed out: ${stderr}`)); }, 15_000);
      proc.stdout.on('data', data => {
        stdout += data.toString();
        if (stdout.endsWith('\n') && !proc.stdin.writableEnded) proc.stdin.end();
      });
      proc.stderr.on('data', data => { stderr += data.toString(); });
      proc.once('error', error => { clearTimeout(timer); reject(error); });
      proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    const response = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.id === 1);
    if (!response?.result) throw new Error(`Memory stub omitted result: ${stderr}`);
    return response.result;
  } finally { proc.kill(); }
}
