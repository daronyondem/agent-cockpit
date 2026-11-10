import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { cortexVersion, resolveCortexRuntime, startCortexRuntime } from '../src/services/backends/cortexRuntime';
import { CortexConnections } from '../src/services/cortexConnections';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { cortexHasCompleteUsage } from '../src/services/backends/cortexUsage';
import { createChatRouterEnv, destroyChatRouterEnv } from '../test/helpers/chatEnv';

/** Expected native failure only: no saved account, login, credential copying or success claim. */
async function main(): Promise<void> {
  assert.equal(process.env.CORTEX_MISSING_AUTH_PROBE, '1', 'Set CORTEX_MISSING_AUTH_PROBE=1 for native execution');
  assert.equal(process.platform, 'darwin'); assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-missing-auth-')); await fs.chmod(root, 0o700);
  const home = path.join(root, 'empty-snowflake'); await fs.mkdir(home, { mode: 0o700 });
  const results: Record<string, unknown> = {};
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  let nativePrompts = 0;
  const sessions = new CortexSessions(async (...args) => {
    const runtime = await startCortexRuntime(...args); const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (...values) => {
      nativePrompts++;
      const result = await prompt(...values);
      assert.equal(runtime.client.diagnostics.loginPromptSeen, false); results.noWaitingBrowserWizard = true;
      return result;
    }; return runtime;
  });
  const adapter = new CortexCodeAdapter({ sessions, workingDir: root }); env.backendRegistry.register(adapter);
  const profile: CliProfile = { id: 'cortex-missing-auth', name: 'Expected missing auth', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', configDir: home,
    cortexCode: { connection: 'cortex_missing_auth_fixture' }, createdAt: '', updatedAt: '' };
  const deadline = setTimeout(() => { results.deadlineExceeded = true; adapter.shutdown(); }, 120_000);
  try {
    results.cliVersion = await cortexVersion(resolveCortexRuntime({ profile, cwd: root, workspaceId: 'missing-auth' }));
    assert.equal(results.cliVersion, '1.2.35');
    assert.deepEqual(await new CortexConnections(home).list(), []); results.emptyConnectionHome = true;
    await env.chatService.saveSettings({ ...(await env.chatService.getSettings()), cliProfiles: [profile], defaultCliProfileId: profile.id });
    // Empty auth omits the model catalog; Cockpit must retain its selection guard.
    const conversation = await env.chatService.createConversation('Missing-auth control', root, 'cortex-code', undefined, undefined, profile.id);
    const ws = await env.connectWs(conversation.id); const reading = env.readWsEvents(ws, 90_000);
    try {
      assert.equal((await env.request('POST', `/api/chat/conversations/${conversation.id}/message`, {
        content: 'Reply exactly AUTH_CONTROL_MUST_NOT_SUCCEED. Do not use tools or start login.',
      })).status, 200);
      const frames = await reading;
      assert.equal(nativePrompts, 0, 'Cockpit must reject unavailable configuration before sending work');
      assert.ok(frames.some(frame => frame.type === 'error' && /model selection is unavailable/i.test(frame.error)));
      assert.equal(frames.some(frame => frame.type === 'usage'), false); results.configurationRejected = true;
      assert.equal(frames.some(frame => ['tool_activity', 'question', 'plan', 'artifact'].includes(frame.type)), false); results.noToolWork = true;
      assert.equal(frames.filter(frame => frame.type === 'done').length, 1); results.oneTerminalBoundary = true;
      const saved = (await env.chatService.getConversation(conversation.id))!;
      assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
      assert.equal(saved.messages.some(message => message.role === 'assistant' && message.content.trim() === 'AUTH_CONTROL_MUST_NOT_SUCCEED'), false);
      results.userPersistedOnce = true;
    } finally { ws.close(); }
    // Independently check native inference, without relaxing Cockpit's guard or
    // pretending that ACP initialization/session creation proves authentication.
    const runtime = await sessions.acquire('native-auth-control', { profile, cwd: root, workspaceId: conversation.workspaceId });
    const updates: ReturnType<typeof cortexRecord>[] = [];
    runtime.subscribe(frame => {
      if (frame.id !== undefined) {
        runtime.client.respond(frame.id, { outcome: { outcome: 'cancelled' } }); return true;
      }
      if (frame.method === 'session/update') updates.push(cortexRecord(frame.params?.update));
    });
    const result = cortexRecord(await runtime.prompt([{ type: 'text', text: 'Reply exactly AUTH_CONTROL_MUST_NOT_SUCCEED. Do not use tools or start login.' }], 60_000));
    assert.equal(nativePrompts, 1); results.nativePromptAttempted = true;
    assert.equal(cortexHasCompleteUsage(result.usage), false);
    const text = updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => cortexRecord(update.content).text || '').join('');
    assert.match(text.trim(), /^Error: Connection error: Error: No Snowflake connection available\./);
    assert.equal(updates.some(update => ['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate))), false);
    results.inferenceRejected = true; results.passed = true;
  } catch (error) {
    await fs.writeFile(path.join(root, 'private-failure.txt'), error instanceof Error ? error.stack || error.message : 'Control failed', { mode: 0o600 });
    throw error;
  } finally {
    clearTimeout(deadline); adapter.shutdown(); await adapter.stopping; await destroyChatRouterEnv(env);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private missing-auth evidence: ${root}\n`);
  }
}
void main().catch(() => { process.stderr.write('CoCo missing-auth control failed; inspect private evidence.\n'); process.exitCode = 1; });
