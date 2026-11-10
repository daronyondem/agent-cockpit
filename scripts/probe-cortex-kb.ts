import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { cortexVersion, resolveCortexRuntime, startCortexRuntime } from '../src/services/backends/cortexRuntime';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { cortexHasCompleteUsage } from '../src/services/backends/cortexUsage';
import { KbIngestionService } from '../src/services/knowledgeBase/ingestion';
import { KbDigestionService } from '../src/services/knowledgeBase/digest';
import { KbDreamService } from '../src/services/knowledgeBase/dream';
import { createKbSearchMcpServer } from '../src/services/kbSearchMcp';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { embedText } from '../src/services/knowledgeBase/embeddings';
import { createChatRouterEnv, destroyChatRouterEnv } from '../test/helpers/chatEnv';
import { cortexKbFixtures } from '../test/helpers/cortexKbFixtures';

/** Native KB services with isolated files/SQLite/PGLite; retains terminal auth. */
async function main() {
  assert.equal(process.env.CORTEX_KB_PROBE, '1', 'Set CORTEX_KB_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Select an authenticated named connection');
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-kb-')); await fs.chmod(reportDir, 0o700);
  const results: Record<string, unknown> = { stage: 'setup' };
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const previousPort = process.env.PORT; process.env.PORT = String((env.server.address() as { port: number }).port);
  await fs.writeFile(path.join(env.tmpDir, 'AGENTS.md'), `# Isolated KB compatibility fixture\nPaths under ${env.tmpDir} are authorized synthetic test data. Perform only the supplied KB task. Loopback Cockpit KB tools are authorized. No external connectors, SQL, native memory, agents, scheduling, publishing or outreach. Return the requested output schema.\n`);
  const calls: Array<{ sessionId: string | null; image: boolean; usage: boolean; interrupted: boolean }> = [];
  let interruptNext = false;
  let interruptedByShutdown = false;
  const tools = new Set<string>();
  const sessions = new CortexSessions(async (...args) => {
    const runtime = await startCortexRuntime(...args);
    runtime.subscribe(frame => {
      const update = cortexRecord(frame.params?.update);
      const title = typeof update.title === 'string' ? update.title : '';
      for (const tool of ['search_entries', 'search_topics', 'get_topic', 'find_similar_topics', 'find_unconnected_similar']) {
        if (title.includes(tool)) tools.add(tool);
      }
    });
    const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = async (blocks, timeout) => {
      const call = { sessionId: runtime.sessionId, image: blocks.some(block => cortexRecord(block).type === 'image'), usage: false, interrupted: interruptNext };
      interruptNext = false;
      calls.push(call);
      const timer = call.interrupted ? setTimeout(() => { interruptedByShutdown = true; adapter.shutdown(); }, 100) : undefined;
      try {
        const result = await prompt(blocks, timeout); call.usage = cortexHasCompleteUsage(cortexRecord(result).usage); return result;
      } finally { clearTimeout(timer); }
    };
    return runtime;
  });
  const adapter = new CortexCodeAdapter({ sessions, workingDir: env.tmpDir }); env.backendRegistry.register(adapter);
  let expired = false;
  const execute = adapter.runSessionShot.bind(adapter);
  adapter.runSessionShot = (prompts, options) => {
    if (expired) return Promise.reject(new Error('Native KB probe completion deadline exceeded.'));
    return execute(prompts, options);
  };
  const deadline = setTimeout(() => { expired = true; adapter.shutdown(); }, 10 * 60_000);
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Native KB fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  try {
    results.cliVersion = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'kb-probe', cwd: env.tmpDir }));
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [profile], defaultCliProfileId: profile.id,
      knowledgeBase: { ingestionCliProfileId: profile.id, ingestionCliModel: 'claude-sonnet-4-6', ingestionCliEffort: 'low',
        digestionCliProfileId: profile.id, digestionCliModel: 'claude-sonnet-4-6', digestionCliEffort: 'low', kbGleaningEnabled: true,
        dreamingCliProfileId: profile.id, dreamingCliModel: 'claude-sonnet-4-6', dreamingCliEffort: 'low', cliConcurrency: 1, convertSlidesToImages: true } });
    const workspaceId = (await env.chatService.createConversation('KB fixture', env.tmpDir, 'cortex-code', 'claude-sonnet-4-6', 'low', profile.id)).workspaceId;
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    await env.chatService.setWorkspaceKbEmbeddingConfig(workspaceId, { dimensions: 768, model: 'nomic-embed-text', ollamaHost: 'http://127.0.0.1:11434' });
    const db = env.chatService.getKbDb(workspaceId)!;
    const queueRegistry = new WorkspaceTaskQueueRegistry();
    const ingestion = new KbIngestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    results.stage = 'native-document-fixtures';
    const fixtures = await cortexKbFixtures(path.join(env.tmpDir, 'source-fixtures')); results.officeVersions = fixtures.versions;
    const conversions: Record<string, unknown> = {}; results.conversions = conversions;
    for (const file of fixtures.files) {
      results.stage = `conversion:${path.extname(file.filename)}`;
      const firstCalls = calls.length;
      const upload = await ingestion.enqueueUpload(workspaceId, file); await ingestion.waitForIdle(workspaceId);
      assert.equal(db.getRawById(upload.entry.rawId)?.status, 'ingested');
      const converted = path.join(env.chatService.getKbConvertedDir(workspaceId), upload.entry.rawId);
      const text = await fs.readFile(path.join(converted, 'text.md'), 'utf8');
      const metaBytes = await fs.readFile(path.join(converted, 'meta.json'), 'utf8'); const meta = JSON.parse(metaBytes);
      assert.match(text, /CORTEX KB 4827/); assert.ok(meta.metadata.sourceCounts['artificial-intelligence'] > 0);
      assert.ok(calls.length > firstCalls && calls.slice(firstCalls).every(call => call.image && call.usage));
      assert.ok(meta.mediaFiles.some((name: string) => name.endsWith('.png')), 'No prepared/raster PNG persisted');
      const convertedCalls = calls.length;
      const reused = await ingestion.enqueueUpload(workspaceId, { ...file, folderPath: 'reused' }); await ingestion.waitForIdle(workspaceId);
      assert.equal(reused.deduped, true); assert.equal(reused.entry.rawId, upload.entry.rawId);
      assert.equal(await fs.readFile(path.join(converted, 'meta.json'), 'utf8'), metaBytes);
      assert.equal(calls.length, convertedCalls, 'Duplicate upload started another inference');
      if (file.mimeType === 'image/jpeg') assert.deepEqual(await fs.readFile(path.join(converted, 'media', file.filename)), file.buffer);
      conversions[path.extname(file.filename)] = { converted: true, aiCalls: calls.length - firstCalls, reused: true, handler: meta.handler };
      process.stdout.write(`Native ${path.extname(file.filename)} conversion/reuse passed\n`);
    }
    results.stage = 'digestion-gleaning';
    const uploaded = await ingestion.enqueueUpload(workspaceId, { filename: 'release-policy.md', mimeType: 'text/markdown', buffer: Buffer.from(
      '# Indigo fixture release policy\nINDIGO_NATIVE_4827 identifies the fixture release process. Every build requires a checksum manifest. The fixture maintainer verifies the checksum before delivery. QVM means Quality Verification Manifest. QVM records the build ID and SHA256 checksum for every delivered fixture.\n') });
    await ingestion.waitForIdle(workspaceId);
    const beforeDigest = calls.length;
    const digestion = new KbDigestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    const digested = await digestion.enqueueDigest(workspaceId, uploaded.entry.rawId);
    assert.equal(digested.error, undefined, 'Native digestion failed'); assert.ok(digested.entryIds.length > 0);
    assert.equal(calls.length - beforeDigest, 2); assert.equal(calls[beforeDigest].sessionId, calls[beforeDigest + 1].sessionId);
    assert.ok(calls.slice(beforeDigest).every(call => call.usage));
    assert.ok(db.listEntries().some(entry => /checksum/i.test(entry.summary)));
    results.digestionGleaning = true; process.stdout.write('Native digestion/gleaning passed\n');
    results.stage = 'dreaming';
    const kb = createKbSearchMcpServer({ chatService: env.chatService }); env.app.use('/cortex-kb-fixture', kb.router);
    const issue = kb.issueKbSearchSession.bind(kb);
    kb.issueKbSearchSession = (...args) => {
      const session = issue(...args);
      for (const server of session.mcpServers) for (const value of server.env || []) {
        if (value.name === 'KB_SEARCH_ENDPOINT') value.value = `${env.baseUrl}/cortex-kb-fixture/kb-search/call`;
      }
      return session;
    };
    const dreaming = new KbDreamService({ chatService: env.chatService, backendRegistry: env.backendRegistry, kbSearchMcp: kb });
    const dreamed = await dreaming.dream(workspaceId);
    assert.deepEqual(dreamed.errors, []); assert.ok(dreamed.processedEntries > 0); assert.ok(db.listTopics().length > 0);
    assert.ok(db.listSynthesisRuns().some(run => run.status === 'completed'));
    assert.match(await fs.readFile(path.join(env.chatService.getKbSynthesisDir(workspaceId), 'index.md'), 'utf8'), /Topic Index/);
    for (const topic of db.listTopics()) assert.ok((await fs.stat(path.join(env.chatService.getKbSynthesisDir(workspaceId), 'topics', `${topic.topicId}.md`))).isFile());
    results.dreaming = true;
    process.stdout.write('Native synthesis and materialized topics passed\n');
    results.stage = 'glossary-embeddings-search';
    assert.equal((await env.request('POST', `/api/chat/workspaces/${workspaceId}/kb/glossary`, { term: 'QVM', expansion: 'Quality Verification Manifest' })).status, 201);
    assert.equal((await env.request('GET', `/api/chat/workspaces/${workspaceId}/kb/glossary`)).body.glossary.length, 1);
    const search = kb.issueKbSearchSession('native-search-fixture', workspaceId);
    const response = await fetch(`${env.baseUrl}/cortex-kb-fixture/kb-search/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kb-search-token': search.token },
      body: JSON.stringify({ tool: 'search_entries', arguments: { query: 'QVM' } }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200); const found = await response.json();
    assert.match(found.expanded_query, /Quality Verification Manifest/); assert.ok(found.entries.length > 0);
    const cfg = await env.chatService.getWorkspaceKbEmbeddingConfig(workspaceId);
    const embedding = (await embedText('Quality Verification Manifest', cfg!)).embedding;
    assert.equal(embedding.length, 768);
    const store = await env.chatService.getKbVectorStore(workspaceId, 768);
    assert.ok((await store!.vectorSearchEntries(embedding, 5)).length > 0);
    results.glossaryAndRealEmbeddings = true;
    const answer = await adapter.runOneShot('Use the Cockpit KB search_entries tool with query QVM and search_topics with query checksum. Explain what QVM expands to and what each release must include, using those tool results. Do not read local files or use external services.', {
      allowTools: true, cliProfile: profile, model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 120_000,
      workingDir: env.chatService.getKbKnowledgeDir(workspaceId), mcpServers: search.mcpServers });
    assert.ok(tools.has('search_entries') && tools.has('search_topics')); assert.match(answer, /Quality Verification Manifest/i); assert.match(answer, /checksum/i);
    kb.revokeKbSearchSession('native-search-fixture'); results.nativeSearchMcp = true;
    results.stage = 'redream';
    const rebuilt = await dreaming.redream(workspaceId);
    assert.deepEqual(rebuilt.errors, []); assert.ok(rebuilt.processedEntries > 0); assert.ok(db.listTopics().length > 0);
    assert.ok(db.listSynthesisRuns().some(run => run.mode === 'redream' && run.status === 'completed'));
    results.redream = true;
    results.stage = 'interrupted-digestion';
    const interrupted = await ingestion.enqueueUpload(workspaceId, { filename: 'interrupted.md', mimeType: 'text/markdown',
      buffer: Buffer.from('# Interrupted fixture\nThe fixture release manager confirms all checksum manifests before delivery.\n') });
    await ingestion.waitForIdle(workspaceId); const beforeInterrupt = calls.length; interruptNext = true;
    const stopped = await digestion.enqueueDigest(workspaceId, interrupted.entry.rawId); await adapter.stopping;
    assert.ok(interruptedByShutdown && stopped.error); assert.equal(calls.length, beforeInterrupt + 1, 'Interrupted digest was resent automatically');
    assert.equal(db.getRawById(interrupted.entry.rawId)?.status, 'failed');
    assert.equal(db.listEntryIdsByRawId(interrupted.entry.rawId).length, 0); results.interruptedWithoutRetry = true;
    assert.equal(await adapter.runOneShot('Reply exactly KB_READY. Do not use tools.', { allowTools: true, cliProfile: profile,
      model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 120_000 }), 'KB_READY'); results.freshAfterInterrupt = true;
    results.tools = [...tools]; results.nativeCalls = calls.length; results.completeUsage = calls.filter(call => !call.interrupted).every(call => call.usage);
    assert.ok(results.completeUsage);
    results.passed = true; delete results.stage;
  } finally {
    clearTimeout(deadline);
    adapter.shutdown(); await adapter.stopping;
    await env.chatService.closeKbVectorStores(); env.chatService.closeKbDatabases(); await destroyChatRouterEnv(env);
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private KB evidence: ${reportDir}\n`);
  }
}
void main().catch(() => { process.stderr.write('Cortex KB probe failed; inspect the private stage report.\n'); process.exitCode = 1; });
