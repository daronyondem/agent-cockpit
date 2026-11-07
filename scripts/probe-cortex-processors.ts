import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createCanvas } from '@napi-rs/canvas';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { cortexVersion, resolveCortexRuntime, startCortexRuntime } from '../src/services/backends/cortexRuntime';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { CortexInputError } from '../src/services/backends/cortexErrors';
import { createChatRouterEnv, destroyChatRouterEnv, CSRF_TOKEN } from '../test/helpers/chatEnv';

/** Opt-in native processor/OCR evidence. Uses shared terminal login without changing it. */
async function main() {
  assert.equal(process.env.CORTEX_PROCESSOR_PROBE, '1', 'Set CORTEX_PROCESSOR_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Select an authenticated named connection');
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-processors-'));
  await fs.chmod(reportDir, 0o700);
  const results: Record<string, unknown> = { stage: 'setup' };
  const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const env = await createChatRouterEnv({ configureDefaultCli: false });
  const workspace = path.join(env.tmpDir, 'workspace'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Processor fixture\nOnly perform the requested temporary fixture work. No external connectors, SQL, native memory, agents, scheduling or publishing.\n');
  let imagePrompts = 0;
  const sessions = new CortexSessions(async (...args) => {
    const runtime = await startCortexRuntime(...args);
    const prompt = runtime.prompt.bind(runtime);
    runtime.prompt = (blocks, timeout) => {
      if (blocks.some(block => (block as { type?: string }).type === 'image')) imagePrompts++;
      return prompt(blocks, timeout);
    };
    return runtime;
  });
  const adapter = new CortexCodeAdapter({ workingDir: workspace, sessions }); env.backendRegistry.register(adapter);
  const profile: CliProfile = { id: 'setup-cortex-code-account', name: 'Native processor fixture', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  const options = { allowTools: true, cliProfile: profile, model: 'claude-sonnet-4-6', effort: 'low' as const, timeoutMs: 120_000 };
  try {
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [profile], defaultCliProfileId: profile.id });
    results.stage = 'metadata';
    results.cliVersion = await cortexVersion(resolveCortexRuntime({ profile, workspaceId: 'processor-probe', cwd: workspace }));
    const metadata = await adapter.getMetadata({ cliProfile: profile });
    assert.ok(metadata.models?.some(model => model.id === options.model));
    results.catalog = true;
    results.stage = 'restricted';
    await assert.rejects(adapter.runOneShot('/command', { cliProfile: profile }), /zero-tool/);
    await assert.rejects(adapter.runSessionShot(['one', 'two'], { cliProfile: profile, allowTools: false }), /zero-tool/);
    results.restrictedRejected = true;
    results.stage = 'sequential';
    const nonce = `NATIVE_${crypto.randomBytes(6).toString('hex')}`;
    const outputs = await adapter.runSessionShot([
      `Remember the nonce ${nonce} for my next message. Reply exactly READY. Do not use tools.`,
      'What was the nonce in my previous message? Reply with only the nonce. Do not use tools.',
    ], options);
    results.sequentialChecks = { ready: /^READY[.!]?$/i.test(outputs[0]), recalled: outputs[1] === nonce, lengths: outputs.map(output => output.length) };
    assert.match(outputs[0], /^READY[.!]?$/i); assert.equal(outputs[1], nonce);
    results.nativeSequential = true;
    process.stdout.write('Native sequential continuity passed\n');
    results.stage = 'headless-question';
    await assert.rejects(adapter.runOneShot('Use the AskUserQuestion tool now to ask me which fixture color I want, with Blue and Green options. Wait for my answer. Do no other work.', options), /requires a human decision/);
    results.headlessQuestion = true;
    results.stage = 'image-ocr';
    const conv = await env.chatService.createConversation('OCR fixture', workspace, 'cortex-code', options.model, options.effort, profile.id);
    const imageDir = path.join(env.chatService.artifactsDir, conv.id); await fs.mkdir(imageDir, { recursive: true });
    const image = path.join(imageDir, 'fixture.png');
    const canvas = createCanvas(900, 220); const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 900, 220); context.fillStyle = 'black'; context.font = '48px sans-serif';
    context.fillText('CORTEX OCR 4827', 50, 110);
    await fs.writeFile(image, canvas.toBuffer('image/png'));
    const response = await fetch(`${env.baseUrl}/api/chat/conversations/${conv.id}/attachments/ocr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': CSRF_TOKEN },
      body: JSON.stringify({ path: image }), signal: AbortSignal.timeout(150_000) });
    const ocr = { status: response.status, body: await response.json() };
    assert.equal(ocr.status, 200, 'Native OCR endpoint failed'); assert.match(ocr.body.markdown, /CORTEX OCR 4827/);
    results.attachmentOcr = true;
    await assert.rejects(adapter.runOneShot('Read the image.', { ...options, model: 'auto', attachments: [{ path: image, kind: 'image' }] }), /not verified/);
    results.unsupportedImageRejected = true;
    process.stdout.write('Native OCR and model gate passed\n');
    results.stage = 'image-cancellation';
    const controller = new AbortController();
    const previousImages = imagePrompts;
    const pending = adapter.runOneShot('Transcribe this image, then use Bash to run sleep 60 before replying.', {
      ...options, attachments: [{ path: image, kind: 'image' }], abortSignal: controller.signal });
    const cancelled = assert.rejects(pending, /cancelled/);
    const timer = setInterval(() => { if (imagePrompts > previousImages) controller.abort(); }, 100);
    try { await cancelled; } finally { clearTimeout(timer); }
    assert.equal(imagePrompts, previousImages + 1, 'Cancellation did not reach a native image prompt');
    results.imageCancellation = true;
    results.stage = 'fresh-after-cancel';
    assert.equal(await adapter.runOneShot('Reply exactly PROCESSOR_OK. Do not use tools.', options), 'PROCESSOR_OK');
    results.freshAfterCancel = true;
    results.passed = true; delete results.stage;
  } catch (error) {
    if (error instanceof CortexInputError) results.failure = error.message;
    throw error;
  } finally {
    adapter.shutdown(); await adapter.stopping;
    await env.chatService.closeKbVectorStores(); env.chatService.closeKbDatabases();
    await destroyChatRouterEnv(env);
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private processor evidence: ${reportDir}\n`);
  }
}
void main().catch(() => { process.stderr.write('Cortex processor probe failed; inspect the private stage report.\n'); process.exitCode = 1; });
