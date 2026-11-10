import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { ClaudeCodeAdapter } from '../src/services/backends/claudeCode';
import { cortexVersion, resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import { createChatRouterEnv, destroyChatRouterEnv } from '../test/helpers/chatEnv';

/** Opt-in native app-route/MCP probe. Never changes shared credentials. */
async function main() {
  assert.equal(process.env.CORTEX_CHAT_PROBE, '1', 'Set CORTEX_CHAT_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Select an authenticated named connection');
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-chat-'));
  await fs.chmod(reportDir, 0o700);
  const results: Record<string, unknown> = { stage: 'setup' };
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const previousPort = process.env.PORT;
  process.env.PORT = String((env.server.address() as { port: number }).port);
  const workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
  const sessions = new CortexSessions();
  const adapter = new CortexCodeAdapter({ workingDir: workspace, sessions });
  const processor = new ClaudeCodeAdapter({ workingDir: workspace });
  let processorCalls = 0;
  const oneShot = processor.runOneShot.bind(processor);
  processor.runOneShot = (prompt, options) => { processorCalls++; return oneShot(prompt, options); };
  env.backendRegistry.register(adapter); env.backendRegistry.register(processor);
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Native Cortex fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  async function send(id: string, content: string) {
    env.wsFns.clearBuffer(id);
    const ws = await env.connectWs(id); const reading = env.readWsEvents(ws, 180_000);
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'tool_activity') process.stdout.write(`Native tool: ${frame.tool}\n`);
    });
    try {
      assert.equal((await env.request('POST', `/api/chat/conversations/${id}/message`, { content })).status, 200);
      const frames = await reading;
      assert.equal(frames.filter(frame => frame.type === 'done').length, 1, 'Missing/duplicate terminal boundary');
      assert.equal(frames.some(frame => frame.type === 'error' && frame.terminal !== false), false, 'Native turn failed');
      assert.equal(frames.filter(frame => frame.type === 'usage').length, 1, 'Missing/duplicate final usage');
      return frames;
    } finally { ws.close(); }
  }
  try {
    const version = await cortexVersion(resolveCortexRuntime({ profile, cwd: workspace, workspaceId: 'probe' }));
    assert.equal(version, '1.2.35', 'Review native version drift before certification');
    results.cliVersion = version;
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), `# Compatibility fixture\nOnly do the requested fixture work. Paths under ${env.tmpDir} are authorized temporary test data. No SQL, web, agents, scheduling, native memory, publishing or external connectors.\n`);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, defaultBackend: 'cortex-code', defaultCliProfileId: profile.id,
      cliProfiles: [profile, { id: 'setup-claude-code-account', name: 'Memory processor', harness: 'claude-code', authMode: 'account',
        command: process.env.CORTEX_TEST_MEMORY_COMMAND || 'claude', createdAt: '', updatedAt: '' }],
      memory: { cliProfileId: 'setup-claude-code-account', cliModel: 'haiku', cliEffort: 'low' } });
    const conv = await env.chatService.createConversation('Native Cortex fixture', workspace, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id);
    const workspaceId = conv.workspaceId;
    await env.chatService.setWorkspaceMemoryEnabled(workspaceId, true);
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    await env.chatService.setWorkspaceKbEmbeddingConfig(workspaceId, { dimensions: 3, model: 'fixture-keyword-only', ollamaHost: 'http://127.0.0.1:1' });
    const db = env.chatService.getKbDb(workspaceId)!;
    db.upsertTopic({ topicId: 'indigo', title: 'INDIGO_KB_314 release policy', summary: 'INDIGO_KB_314 requires a checksum manifest.',
      content: 'Every INDIGO_KB_314 release must include a checksum manifest.', updatedAt: new Date().toISOString() });
    const vectors = (await env.chatService.getKbVectorStore(workspaceId, 3))!;
    await vectors.upsertTopic('indigo', 'INDIGO_KB_314 release policy', 'INDIGO_KB_314 requires a checksum manifest.', [1, 0, 0]);
    results.stage = 'managed-mcp';
    const first = await send(conv.id, 'Remember the synthetic conversation code CEDAR_CHAT_314 for later turns. Use the Agent Cockpit memory_note MCP tool to save this permanent workspace project rule: Every fixture release must use the MAUVE_MEMORY_314 accent identifier. Then use memory_search for MAUVE_MEMORY_314, KB search_topics for INDIGO_KB_314, and get_topic for the matching topic. Report the exact accent identifier and the full KB policy. Do no other work. If any tool fails, report the failure and do not create fallback memory files.');
    const tools = first.filter(frame => frame.type === 'tool_activity').map(frame => frame.tool);
    for (const tool of ['memory_note', 'memory_search', 'search_topics', 'get_topic']) assert.ok(tools.some(name => name.includes(tool)), `Native ${tool} was not called`);
    assert.ok(processorCalls > 0, 'Real separate Memory processor was not invoked');
    assert.ok((await env.chatService.searchWorkspaceMemory(workspaceId, { query: 'MAUVE_MEMORY_314' })).length > 0, 'Governed memory was not persisted');
    let saved = (await env.chatService.getConversation(conv.id))!;
    const answer = saved.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
    assert.match(answer, /MAUVE_MEMORY_314/); assert.match(answer, /checksum/i);
    const nativeId = saved.externalSessionId;
    results.mcp = { nativePluginDiscovery: true, realStdioShims: true, separateMemoryProcessor: true, governedNotePersisted: true,
      memorySearch: true, pgliteKeywordSearch: true, sqliteTopicRead: true, ollamaSemanticSearch: 'not tested' };
    process.stdout.write('PASS native plugin discovery, Memory governance/search and SQLite/PGLite KB access\n');
    results.stage = 'resume';
    await sessions.evictIdle(0);
    await send(conv.id, 'Return only the synthetic conversation code I asked you to remember. Do not call tools.');
    adapter.shutdown(); await adapter.stopping;
    await send(conv.id, 'Return only the synthetic conversation code I asked you to remember. Do not call tools.');
    saved = (await env.chatService.getConversation(conv.id))!;
    assert.equal(saved.externalSessionId, nativeId);
    assert.equal(saved.messages.filter(message => message.role === 'assistant' && message.turn === 'final').length, 3);
    assert.equal(saved.messages.filter(message => message.role === 'assistant').at(-1)?.content.trim(), 'CEDAR_CHAT_314');
    results.resume = { idleReload: true, adapterRestartReload: true, nativeIdRetained: true, nonceRetained: true, persistedAnswersOnce: true, usageOncePerTurn: true };
    process.stdout.write('PASS native nonce continuity through idle eviction and adapter restart\n');
    results.stage = 'artifacts';
    const target = path.join(workspace, 'native-report.txt');
    const delivery = await send(conv.id, `Use native write to create native-report.txt containing exactly CORTEX_CHAT_ARTIFACT, then native read to verify it. Deliver it using this exact standalone marker: <!-- FILE_DELIVERY:${target} -->. Do no other work.`);
    assert.equal((await fs.readFile(target, 'utf8')).trimEnd(), 'CORTEX_CHAT_ARTIFACT');
    assert.ok(delivery.some(frame => frame.type === 'artifact'));
    saved = (await env.chatService.getConversation(conv.id))!;
    assert.ok(saved.messages.some(message => message.contentBlocks?.some(block => block.type === 'artifact')));
    results.artifacts = { realFileVerified: true, deliveredAndPersisted: true };
    process.stdout.write('PASS native file delivery and persisted artifact\n');
    results.stage = 'relocation';
    const relocated = path.join(env.tmpDir, 'relocated-workspace');
    await fs.rename(workspace, relocated);
    await env.chatService.updateWorkspaceLocation(workspaceId, relocated);
    await send(conv.id, 'The workspace folder was relocated. Use native read to read native-report.txt relative to the current workspace, then native write to create relocated-proof.txt in the current workspace with exactly the same content. Return only the original synthetic conversation code I asked you to remember. Do no other work.');
    assert.equal((await fs.readFile(path.join(relocated, 'relocated-proof.txt'), 'utf8')).trimEnd(), 'CORTEX_CHAT_ARTIFACT');
    saved = (await env.chatService.getConversation(conv.id))!;
    assert.equal(saved.workspaceId, workspaceId); assert.equal(saved.externalSessionId, nativeId);
    assert.equal(saved.messages.filter(message => message.role === 'assistant').at(-1)?.content.trim(), 'CEDAR_CHAT_314');
    await assert.rejects(fs.access(workspace));
    results.relocation = { canonicalWorkspaceIdRetained: true, nativeSessionIdRetained: true, nonceRetained: true, nativeReadWriteInNewCwd: true };
    process.stdout.write('PASS native load after relocation and read/write in the new working directory\n');
    delete results.stage;
    results.passed = true;
  } finally {
    adapter.shutdown(); await adapter.stopping; processor.shutdown();
    await env.chatService.closeKbVectorStores();
    env.chatService.closeKbDatabases();
    await destroyChatRouterEnv(env);
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private chat evidence: ${reportDir}\n`);
  }
}
main().catch(error => { process.stderr.write(`Cortex chat probe failed (${error instanceof Error ? error.name : 'unknown'}).\n`); process.exitCode = 1; });
