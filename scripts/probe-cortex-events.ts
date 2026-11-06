import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createCanvas } from '@napi-rs/canvas';
import type { CliProfile, StreamEvent, CortexTurnOptions } from '../src/types';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { CortexTurn } from '../src/services/backends/cortexTurn';
import { configureCortex, cortexConfigOptions, cortexModels } from '../src/services/backends/cortexModels';
import { ArtifactStore } from '../src/services/chat/artifactStore';
import { CortexEventDecoder } from '../src/services/backends/cortexEvents';
import { cortexTerminalError } from '../src/services/backends/cortexErrors';

async function main() {
  assert.equal(process.env.CORTEX_EVENTS_PROBE, '1', 'Set CORTEX_EVENTS_PROBE=1 for real inference');
  assert.notEqual(process.env.CORTEX_ACP_TEST_MODE, '1', 'Fake mode is not native evidence');
  assert.equal(process.platform, 'darwin', 'This probe certifies macOS only');
  const connection = process.env.CORTEX_TEST_CONNECTION;
  assert.ok(connection, 'Select an authenticated named connection');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-events-'));
  await fs.chmod(root, 0o700);
  const profile: CliProfile = { id: 'events-probe', name: 'Events probe', harness: 'cortex-code', authMode: 'account',
    command: process.env.CORTEX_TEST_COMMAND || 'cortex', cortexCode: { connection }, createdAt: '', updatedAt: '' };
  const sessions = new CortexSessions();
  const results: Record<string, unknown> = {};
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()), results };
  const store = new ArtifactStore({ artifactsDir: path.join(root, 'stored-artifacts'), hasConversation: id => id === 'probe' });
  async function runtime(name: string, selected = profile) {
    const cwd = path.join(root, name); await fs.mkdir(cwd, { recursive: true });
    const value = await sessions.acquire(name, { profile: selected, workspaceId: name, cwd });
    assert.equal(value.version, '1.2.35', 'Review this probe before certifying another version');
    report.cliVersion = value.version;
    return value;
  }
  async function collect(native: Awaited<ReturnType<typeof runtime>>, options: Partial<CortexTurnOptions> & { text: string }, decide?: (event: StreamEvent, turn: CortexTurn) => Promise<void>) {
    const turn = new CortexTurn(native, { allowTools: true, model: 'claude-sonnet-4-6', effort: 'low', timeoutMs: 180_000, ...options });
    const events: StreamEvent[] = [];
    for await (const event of turn.stream()) { events.push(event); await decide?.(event, turn); }
    const errors = events.filter(event => event.type === 'error' && event.terminal !== false);
    assert.equal(errors.length, 0, 'Native turn failed');
    assert.equal(events.filter(event => event.type === 'usage').length, 1, 'Native final usage missing/duplicated');
    return events;
  }
  try {
    const native = await runtime('files');
    assert.ok(cortexModels(native.configOptions, native.version).some(model => model.id === 'claude-sonnet-4-6'));
    await configureCortex(native, { model: 'claude-sonnet-4-6', effort: 'low' });
    await configureCortex(native, { model: 'claude-sonnet-4-6' });
    assert.equal(cortexConfigOptions(native.configOptions).find(option => option.id === 'thought_level')?.currentValue, 'auto');
    results.configuration = { dynamicCatalog: true, explicitEffortToAuto: true };
    process.stdout.write('PASS native configuration and reset-to-auto\n');
    const fileEvents = await collect(native, { text: `Use native write to create result.txt containing exactly CORTEX_EVENTS_OK, then native read to verify. Only this temporary workspace. Do not use agents, web, SQL or background work. Deliver the file with this exact marker on its own line: <!-- FILE_DELIVERY:${path.join(native.config.cwd, 'result.txt')} -->` });
    const written = await fs.readFile(path.join(native.config.cwd, 'result.txt'));
    assert.equal(written.toString('utf8').trimEnd(), 'CORTEX_EVENTS_OK');
    const artifact = fileEvents.find(event => event.type === 'artifact');
    assert.ok(artifact && artifact.sourcePath);
    const stored = await store.createConversationArtifact('probe', artifact);
    assert.ok(stored); assert.deepEqual(await fs.readFile(stored.path), written);
    results.files = { nativeTools: true, outputVerified: true, artifactStored: true, usageOnce: true };
    process.stdout.write('PASS native tools, artifact persistence and final usage\n');

    const questions = await runtime('questions');
    let decisions = 0;
    const questionEvents = await collect(questions, { text: 'Use ask_user_question with TWO questions in one invocation. Ask "Which fixture color?" with Blue and Green; then "Which backup color?" with Blue and Green. Wait for both answers, then repeat both. No other tools, agents, SQL or background work.' }, async (event, turn) => {
      if (event.type === 'tool_activity' && event.isQuestion) {
        assert.ok(event.id);
        assert.ok(turn.input(decisions++ === 0 ? 'Violet fixture' : 'Green', event.id));
        assert.equal(turn.input('stale duplicate', event.id), false);
      }
    });
    assert.equal(decisions, 2);
    assert.match(questionEvents.filter(event => event.type === 'text').map(event => event.content).join(''), /Violet fixture/);
    results.questions = { sequential: true, freeForm: true, staleDuplicateRejected: true };
    process.stdout.write('PASS sequential questions, free-form reply and duplicate rejection\n');

    const planned = await runtime('plan');
    let approvals = 0;
    const target = path.join(planned.config.cwd, 'approved.txt');
    await collect(planned, { mode: 'plan', text: 'Plan creating approved.txt containing exactly PLAN_APPROVED, then ask for plan approval using exit_plan_mode. Wait for approval before any write. If asked to revise, add a read-back verification and ask again. After approval execute with native write/read only. No agents, SQL, web or background work; all work inside this temporary workspace.' }, async (event, turn) => {
      if (event.type === 'tool_activity' && event.planAction === 'exit') {
        assert.ok(event.id && event.planContent);
        await assert.rejects(fs.access(target));
        assert.ok(turn.input(approvals++ === 0 ? 'Revise: add an explicit read-back verification before finishing.' : 'approve', event.id));
      }
    });
    assert.equal(approvals, 2); assert.equal((await fs.readFile(target, 'utf8')).trimEnd(), 'PLAN_APPROVED');
    results.plans = { revisedGate: true, noWriteBeforeApproval: true, executionAfterApproval: true };
    process.stdout.write('PASS revised plan gate and approval-controlled write\n');

    const images = await runtime('images');
    const uploads = path.join(root, 'uploads'); await fs.mkdir(uploads);
    const canvas = createCanvas(160, 80); const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 160, 80);
    context.fillStyle = 'blue'; context.fillRect(12, 12, 52, 52);
    context.fillStyle = 'green'; context.beginPath(); context.arc(120, 40, 26, 0, Math.PI * 2); context.fill();
    const image = path.join(uploads, 'fixture.png'); await fs.writeFile(image, canvas.toBuffer('image/png'));
    const imageEvents = await collect(images, { text: 'Describe the two colored shapes in the attached image. Do not call tools.',
      attachmentRoot: uploads, attachments: [{ path: image, name: 'fixture.png', kind: 'image' }] });
    const description = imageEvents.filter(event => event.type === 'text').map(event => event.content).join('');
    assert.match(description, /blue/i); assert.match(description, /square/i); assert.match(description, /green/i); assert.match(description, /circle/i);
    results.images = { explicitPngTransport: true, verifiedModel: true, shapesIdentified: true };
    process.stdout.write('PASS validated explicit PNG image input\n');

    const empty = path.join(root, 'empty-auth'); await fs.mkdir(empty);
    const missing = await runtime('missing-auth', { ...profile, configDir: empty });
    const turn = new CortexTurn(missing, { text: 'Reply exactly SHOULD_NOT_SUCCEED. Do not call tools.', allowTools: false, model: 'claude-sonnet-4-6', effort: 'low' });
    const errors: StreamEvent[] = []; for await (const event of turn.stream()) errors.push(event);
    // Empty auth also removes the native model catalog. Configured chat must
    // fail validation rather than silently bypassing that catalog boundary.
    assert.ok(errors.some(event => event.type === 'error' && event.error.includes('model selection is unavailable')));
    assert.equal(errors.some(event => event.type === 'text' || event.type === 'result' || event.type === 'usage'), false);
    // Independently exercise the retained native inference error signature with
    // no selected-model override; this is a probe, never a processor fallback.
    const decoder = new CortexEventDecoder(missing.sessionId!);
    const stop = missing.subscribe(message => { decoder.decode(message); });
    const failed = await missing.prompt([{ type: 'text', text: 'Reply exactly SHOULD_NOT_SUCCEED. Do not call tools.' }]);
    stop();
    assert.ok(cortexTerminalError(failed, decoder.finalText, missing.version)?.error.includes('could not connect'));
    results.missingAuth = { configuredTurnBlockedByMissingCatalog: true, nativeInferenceErrorClassified: true, rawNativeDiagnosticNotStreamed: true, noSuccessOrUsage: true };
    results.passed = true;
    process.stdout.write('PASS missing-auth classification without raw diagnostic streaming\n');
  } finally {
    await sessions.shutdown();
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(`Private event evidence: ${root}\n`);
  }
}
main().catch(error => { process.stderr.write(`Cortex event probe failed (${error instanceof Error ? error.name : 'unknown'}).\n`); process.exitCode = 1; });
