import fs from 'fs';
import os from 'os';
import path from 'path';
import { KbIngestionService } from '../src/services/knowledgeBase/ingestion';
import { KbDigestionService } from '../src/services/knowledgeBase/digest';
import { KbDreamService } from '../src/services/knowledgeBase/dream';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { createKbSearchMcpServer } from '../src/services/kbSearchMcp';
import { RoutinesService } from '../src/services/routines/service';
import { createCopilotWorkflowEnv, type CopilotWorkflowEnv } from './helpers/copilotWorkflowEnv';

const integration = process.platform === 'win32' ? describe.skip : describe;
const entry = (slug: string) => `---\ntitle: ${slug}\nslug: ${slug}\nsummary: Synthetic checksum rule.\ntags: [fixture]\n---\nCOPILOT_KB_571 requires a checksum manifest.\n`;

integration('Copilot KB and Routine application workflows', () => {
  let env: CopilotWorkflowEnv;
  let ingestion: KbIngestionService;
  let digestion: KbDigestionService;
  let routines: RoutinesService;
  let plan: { digest: string; glean: string; dream: string; routine: string; wait?: boolean; error?: boolean };
  let planFile: string;
  let callsFile: string;
  const writePlan = () => fs.writeFileSync(planFile, JSON.stringify(plan));
  const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { prompt: string; args: string[]; cwd: string }) : [];

  beforeEach(async () => {
    env = await createCopilotWorkflowEnv();
    planFile = path.join(env.tmpDir, 'processor-plan.json');
    callsFile = path.join(env.tmpDir, 'processor-calls.jsonl');
    plan = { digest: entry('checksum'), glean: entry('ownership'), dream: '{"operations":[]}', routine: 'COPILOT_ROUTINE_571' };
    writePlan();
    const launcher = path.join(env.tmpDir, 'copilot-processors');
    fs.writeFileSync(launcher, String.raw`#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2);
const prompt=args[args.indexOf('-p')+1];
const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({prompt,args,cwd:process.cwd()})+'\n');
if (!args.includes('--allow-all')) throw new Error('Processor tools were not enabled');
if (plan.error) { console.error('Fixture processor failure'); process.exit(1); }
if (plan.wait) { setInterval(()=>{},1000); return; }
let output;
if (prompt.includes('## Routine Markdown')) {
  const routine=prompt.match(/^Routine file: (.+)$/m)[1];
  if (!fs.readFileSync(routine,'utf8').includes('COPILOT_ROUTINE_571')) throw new Error('Routine markdown missing');
  const destination=prompt.match(/^Output folder: (.+)$/m)[1];
  fs.writeFileSync(require('path').join(destination,'fixture.txt'),'COPILOT_ROUTINE_571');
  output=plan.routine;
} else if (prompt.includes('# Knowledge Base gleaning pass')) {
  if (!prompt.includes('## Response 1') || !prompt.includes('COPILOT_KB_571')) throw new Error('Gleaning lost the first response');
  output=plan.glean;
} else if (prompt.includes('# Knowledge Base digestion request')) {
  const source=prompt.match(/^- Converted text \(relative to knowledge\/\): (.+)$/m)[1];
  if (!fs.readFileSync(source,'utf8').includes('COPILOT_KB_571')) throw new Error('Missing real converted source');
  output=plan.digest;
} else {
  for (const match of prompt.matchAll(/— read at (entries\/[^\n]+)/g)) {
    if (!fs.readFileSync(match[1],'utf8').includes('COPILOT_KB_571')) throw new Error('Missing real entry');
  }
  output=plan.dream;
}
console.log(JSON.stringify({type:'assistant.message',data:{messageId:'final',content:output}}));
console.log(JSON.stringify({type:'result',exitCode:0,usage:{}}));
`);
    fs.chmodSync(launcher, 0o755);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings,
      cliProfiles: settings.cliProfiles!.map(profile => ({ ...profile, command: launcher })),
      knowledgeBase: { digestionCliProfileId: env.profileId, digestionCliModel: 'gpt-4', dreamingCliProfileId: env.profileId, dreamingCliModel: 'gpt-4', kbGleaningEnabled: true, cliConcurrency: 1 },
    });
    await env.chatService.setWorkspaceKbEnabled(env.conv.workspaceId, true);
    const queueRegistry = new WorkspaceTaskQueueRegistry();
    ingestion = new KbIngestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    digestion = new KbDigestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry });
    routines = new RoutinesService({ chatService: env.chatService, backendRegistry: env.backendRegistry });
  });
  afterEach(async () => {
    if (!env) return;
    await env.backendRegistry.shutdownAll();
    await ingestion?.waitForIdle(env.conv.workspaceId);
    await digestion?.waitForIdle(env.conv.workspaceId);
    env.chatService.closeKbDatabases();
    await env.chatService.closeKbVectorStores();
    await env.close();
  });
  async function seedRaw() {
    const uploaded = await ingestion.enqueueUpload(env.conv.workspaceId, { filename: 'fixture.md', mimeType: 'text/markdown', buffer: Buffer.from('# Synthetic release\nCOPILOT_KB_571 requires a checksum manifest. The fixture maintainer owns verification.\n') });
    await ingestion.waitForIdle(env.conv.workspaceId);
    return uploaded.entry.rawId;
  }
  async function waitForCall(count: number) {
    const deadline = Date.now() + 5000;
    while (calls().length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls()).toHaveLength(count);
  }
  async function seedRoutine() {
    await env.chatService.setWorkspaceRoutinesEnabled(env.conv.workspaceId, true);
    await routines.ensureWorkspace(env.conv.workspaceId);
    const dir = routines.getRoutineDir(env.conv.workspaceId, 'fixture');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'agent-cockpit.routine', id: 'fixture', title: 'Synthetic routine', routineFile: 'routine.md', state: 'enabled', trigger: { type: 'manual' }, notification: { mode: 'off' }, harness: { cliProfileId: env.profileId, model: 'gpt-4' }, timeoutMinutes: 1 }));
    fs.writeFileSync(path.join(dir, 'routine.md'), '# Synthetic routine\nWrite COPILOT_ROUTINE_571 to the authorized output folder.\n');
    return dir;
  }

  test('digests and gleans real converted input through Copilot and persists both structured entries', async () => {
    const rawId = await seedRaw();
    const result = await digestion.enqueueDigest(env.conv.workspaceId, rawId);
    expect(result.error).toBeUndefined();
    const db = env.chatService.getKbDb(env.conv.workspaceId)!;
    expect(db.getRawById(rawId)?.status).toBe('digested');
    expect(db.listEntries({ rawId }).map(item => item.slug).sort()).toEqual(['checksum', 'ownership']);
    for (const id of result.entryIds) expect(fs.readFileSync(path.join(env.chatService.getKbEntriesDir(env.conv.workspaceId), id, 'entry.md'), 'utf8')).toContain('COPILOT_KB_571');
    expect(calls()).toHaveLength(2);
    expect(calls().every(call => call.cwd === fs.realpathSync(env.chatService.getKbKnowledgeDir(env.conv.workspaceId)))).toBe(true);
    expect(calls()[1].prompt).toContain('## Response 1');
  });

  test('rejects malformed digestion without partial entries and succeeds after a corrected retry', async () => {
    const rawId = await seedRaw();
    plan.digest = 'not a structured entry';
    writePlan();
    expect((await digestion.enqueueDigest(env.conv.workspaceId, rawId)).error).toBeDefined();
    expect(env.chatService.getKbDb(env.conv.workspaceId)!.listEntries({ rawId })).toHaveLength(0);
    plan.digest = entry('checksum');
    writePlan();
    expect((await digestion.enqueueDigest(env.conv.workspaceId, rawId)).error).toBeUndefined();
    expect(env.chatService.getKbDb(env.conv.workspaceId)!.listEntries({ rawId })).toHaveLength(2);
  });

  test('cancels an active Copilot digest on shutdown and preserves source data for retry', async () => {
    const rawId = await seedRaw();
    plan.wait = true;
    writePlan();
    const run = digestion.enqueueDigest(env.conv.workspaceId, rawId);
    await waitForCall(1);
    await env.adapter.shutdown();
    expect((await run).error).toBeDefined();
    const db = env.chatService.getKbDb(env.conv.workspaceId)!;
    expect(db.listEntries({ rawId })).toHaveLength(0);
    expect(db.getRawById(rawId)).not.toBeNull();
    plan.wait = false;
    writePlan();
    expect((await digestion.enqueueDigest(env.conv.workspaceId, rawId)).error).toBeUndefined();
  });

  test('dreaming rejects malformed Copilot operations, retains pending entries, then persists valid topics and markdown', async () => {
    const rawId = await seedRaw();
    await digestion.enqueueDigest(env.conv.workspaceId, rawId);
    const db = env.chatService.getKbDb(env.conv.workspaceId)!;
    const ids = db.listEntries({ rawId }).map(item => item.entryId);
    const dream = new KbDreamService({ chatService: env.chatService, backendRegistry: env.backendRegistry, kbSearchMcp: createKbSearchMcpServer({ chatService: env.chatService }) });
    plan.dream = 'invalid operations';
    writePlan();
    expect((await dream.dream(env.conv.workspaceId)).errors.length).toBeGreaterThan(0);
    expect(db.listNeedsSynthesisEntryIds().sort()).toEqual(ids.sort());
    expect(db.listTopicSummaries()).toHaveLength(0);
    plan.dream = JSON.stringify({ operations: [
      { op: 'create_topic', topic_id: 'checksum-fixture', title: 'Synthetic checksum policy', summary: 'COPILOT_KB_571 checksum policy', content: '# Synthetic checksum policy\nCOPILOT_KB_571 requires a checksum manifest.' },
      { op: 'assign_entries', topic_id: 'checksum-fixture', entry_ids: ids },
    ] });
    writePlan();
    const result = await dream.dream(env.conv.workspaceId);
    expect(result.errors).toEqual([]);
    expect(result.processedEntries).toBe(2);
    expect(db.listNeedsSynthesisEntryIds()).toHaveLength(0);
    expect(db.listTopicSummaries()).toEqual([expect.objectContaining({ topicId: 'checksum-fixture' })]);
    const dir = env.chatService.getKbSynthesisDir(env.conv.workspaceId);
    const markdown = fs.readdirSync(dir, { recursive: true }).filter(file => String(file).endsWith('.md')).map(file => fs.readFileSync(path.join(dir, String(file)), 'utf8')).join('\n');
    expect(markdown).toContain('COPILOT_KB_571');
    expect(db.listSynthesisRuns()[0].status).toBe('completed');
  });

  test('disabled Routines stay passive; enabled Copilot runs validate proposals and persist authorized artifacts and history', async () => {
    const root = routines.getRoutineDir(env.conv.workspaceId, 'fixture');
    expect(await routines.runRoutine(env.conv.workspaceId, 'fixture', { source: 'manual' })).toBeNull();
    expect(fs.existsSync(root)).toBe(false);
    expect(calls()).toHaveLength(0);
    const dir = await seedRoutine();
    expect(await routines.validateProposalMarker(env.conv.workspaceId, path.join(os.tmpdir(), 'untrusted-manifest.json'))).toBeNull();
    expect(await routines.validateProposalMarker(env.conv.workspaceId, path.join(dir, 'manifest.json'))).toMatchObject({ routineId: 'fixture' });
    const run = await routines.runRoutine(env.conv.workspaceId, 'fixture', { source: 'manual' });
    expect(run).toMatchObject({ status: 'completed' });
    expect(fs.readFileSync(run!.finalPath!, 'utf8')).toContain('COPILOT_ROUTINE_571');
    expect(fs.readFileSync(path.join(run!.outputDir, 'fixture.txt'), 'utf8')).toBe('COPILOT_ROUTINE_571');
    expect(run!.notificationSentAt).toBeFalsy();
    expect((await routines.getRoutine(env.conv.workspaceId, 'fixture'))!.runs[0].runId).toBe(run!.runId);
    expect(calls()[0].cwd).toBe(fs.realpathSync(env.workspace));
  });

  test('Routine overlap is rejected, cancellation records failure, and Copilot can run a later retry', async () => {
    await seedRoutine();
    plan.wait = true;
    writePlan();
    const run = routines.runRoutine(env.conv.workspaceId, 'fixture', { source: 'manual' });
    const settled = run.then(() => null, (error: Error) => error);
    await waitForCall(1);
    await expect(routines.runRoutine(env.conv.workspaceId, 'fixture', { source: 'manual' })).rejects.toThrow('already running');
    await env.adapter.shutdown();
    expect((await settled)?.message).toContain('aborted');
    expect((await routines.getRoutine(env.conv.workspaceId, 'fixture'))!.runs[0]).toMatchObject({ status: 'failed' });
    plan.wait = false;
    writePlan();
    expect(await routines.runRoutine(env.conv.workspaceId, 'fixture', { source: 'manual' })).toMatchObject({ status: 'completed' });
  });
});
