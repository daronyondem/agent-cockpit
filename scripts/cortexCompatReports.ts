import fs from 'fs/promises';
import path from 'path';

export const CORTEX_PROBES = {
  backend: [
    { id: 'runtime', flag: 'CORTEX_RUNTIME_PROBE', prefix: 'cockpit-cortex-runtime-', minutes: 8 },
    { id: 'events', flag: 'CORTEX_EVENTS_PROBE', prefix: 'cockpit-cortex-events-', minutes: 15 },
    { id: 'processors', flag: 'CORTEX_PROCESSOR_PROBE', prefix: 'cockpit-cortex-processors-', minutes: 12 },
  ],
  ui: [
    { id: 'auth', flag: 'CORTEX_AUTH_PROBE', prefix: 'cockpit-cortex-auth-ui-', minutes: 12 },
    { id: 'interactions', flag: 'CORTEX_INTERACTION_PROBE', prefix: 'cockpit-cortex-interactions-', minutes: 12 },
    { id: 'queue', flag: 'CORTEX_QUEUE_PROBE', prefix: 'cockpit-cortex-queue-', minutes: 10 },
    { id: 'usage', flag: 'CORTEX_USAGE_PROBE', prefix: 'cockpit-cortex-usage-', minutes: 12 },
    { id: 'mobile', flag: 'CORTEX_MOBILE_PROBE', prefix: 'cockpit-cortex-mobile-', minutes: 15 },
  ],
  workflows: [
    { id: 'chat', flag: 'CORTEX_CHAT_PROBE', prefix: 'cockpit-cortex-chat-', minutes: 12 },
    { id: 'kb', flag: 'CORTEX_KB_PROBE', prefix: 'cockpit-cortex-kb-', minutes: 12 },
    { id: 'context', flag: 'CORTEX_CONTEXT_PROBE', prefix: 'cockpit-cortex-context-', minutes: 12 },
    { id: 'routines', flag: 'CORTEX_ROUTINES_PROBE', prefix: 'cockpit-cortex-routines-', minutes: 12 },
    { id: 'mobile', flag: 'CORTEX_MOBILE_PROBE', prefix: 'cockpit-cortex-mobile-', minutes: 15 },
  ],
  'auth-control': [
    { id: 'missing-auth', flag: 'CORTEX_MISSING_AUTH_PROBE', prefix: 'cockpit-cortex-missing-auth-', minutes: 3 },
  ],
} as const;
export type CortexCompatSuite = keyof typeof CORTEX_PROBES;

/** Required real workflow outcomes, not just successful process startup. */
export const CORTEX_WORKFLOW_CHECKS: Record<string, readonly (readonly string[])[]> = {
  chat: [
    ['mcp', 'nativePluginDiscovery'], ['mcp', 'realStdioShims'], ['mcp', 'separateMemoryProcessor'], ['mcp', 'governedNotePersisted'],
    ['mcp', 'memorySearch'], ['mcp', 'pgliteKeywordSearch'], ['mcp', 'sqliteTopicRead'],
    ['resume', 'idleReload'], ['resume', 'adapterRestartReload'], ['resume', 'nonceRetained'], ['resume', 'persistedAnswersOnce'],
    ['resume', 'usageOncePerTurn'], ['artifacts', 'realFileVerified'], ['artifacts', 'deliveredAndPersisted'],
    ['relocation', 'canonicalWorkspaceIdRetained'], ['relocation', 'nativeSessionIdRetained'], ['relocation', 'nativeReadWriteInNewCwd'],
  ],
  kb: [
    ...['.jpg', '.pdf', '.docx', '.pptx'].flatMap(ext => [['conversions', ext, 'converted'], ['conversions', ext, 'reused']]),
    ['digestionGleaning'], ['dreaming'], ['glossaryAndRealEmbeddings'], ['nativeSearchMcp'], ['redream'],
    ['interruptedWithoutRetry'], ['freshAfterInterrupt'], ['completeUsage'],
  ],
  context: [['disabledAndZeroSource'], ['scanAndUploadedSource'], ['maintenanceMemoryAndRetention'],
    ['scheduledScanAndMaintenance'], ['stoppedWithoutRetryOrDeletion'], ['freshAfterStop'], ['completeUsage']],
  routines: [['proposalAndInstall'], ['manualOutputStateHistoryAndStub'], ['scheduledStateContinuity'],
    ['nativeMinuteTimeoutWithoutRetryOrOutreach'], ['disabledPreservesDataAndFreshInference'], ['completeUsage']],
  mobile: [['unsupportedGoalDenied'], ['ocr', 'native'], ['ocr', 'selectedModelEffort'], ['ocr', 'cacheReused'], ['ocr', 'unverifiedModelDenied'],
    ['media', 'nativeImageAndText'], ['media', 'thinking'], ['media', 'tools'], ['media', 'socketReplay'], ['media', 'explicitArtifact'],
    ['media', 'durablePreviewDownload'], ['history', 'readOnlySession'], ['history', 'retainedArtifact'],
    ['recovery', 'descendantsDrained'], ['recovery', 'oneToolAttempt'], ['recovery', 'freshInference']],
  'missing-auth': [['emptyConnectionHome'], ['configurationRejected'], ['nativePromptAttempted'], ['noWaitingBrowserWizard'], ['inferenceRejected'], ['noToolWork'], ['oneTerminalBoundary'], ['userPersistedOnce']],
};

export function selectCortexProbes(suite: CortexCompatSuite, args: string[]) {
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--probe' || !args[i + 1]) throw new Error('Use --probe <id> or --list');
    ids.push(args[++i]);
  }
  const available = CORTEX_PROBES[suite];
  if (ids.some(id => !available.some(probe => probe.id === id)) || new Set(ids).size !== ids.length) throw new Error('Unknown or duplicate probe selection');
  return available.filter(probe => !ids.length || ids.includes(probe.id));
}

/** Project only validated metadata and fixed outcomes, never native report text/keys. */
export async function readCortexProbeReport(tmp: string, prefix: string, revision: string, checks: readonly (readonly string[])[] = []) {
  const dirs = (await fs.readdir(tmp, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith(prefix));
  if (dirs.length !== 1) throw new Error('Expected one native probe report');
  const file = path.join(tmp, dirs[0].name, 'report.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid native report file');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const cliVersion = raw.cliVersion || raw.results?.cliVersion;
  if (raw.platform !== process.platform || raw.arch !== process.arch || raw.node !== process.version
    || cliVersion !== '1.2.35' || raw.revision !== revision || typeof raw.dirty !== 'boolean') throw new Error('Native report metadata mismatch');
  const evidence = checks.every(keys => keys.reduce((value, key) => value?.[key], raw.results) === true);
  return { passed: raw.results?.passed === true && raw.results?.deadlineExceeded !== true && evidence,
    cliVersion: '1.2.35', revision, dirty: raw.dirty as boolean,
    ...(checks.length ? { checks: checks.map(keys => keys.join('.')), evidenceComplete: evidence } : {}) };
}
